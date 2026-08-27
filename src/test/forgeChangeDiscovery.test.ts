import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ForgeChangeDiscovery,
  ForgeChangeDiscoveryFileSystem,
} from '../forge/changes/ForgeChangeDiscovery';

class StubFileSystem implements ForgeChangeDiscoveryFileSystem {
  constructor(
    private readonly entries: readonly [string, vscode.FileType][],
    private readonly manifests: ReadonlyMap<string, string>,
    private readonly statError?: Error
  ) {}

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    void uri;
    if (this.statError) {
      throw this.statError;
    }

    return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
  }

  async readDirectory(): Promise<readonly [string, vscode.FileType][]> {
    return this.entries;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const manifest = this.manifests.get(uri.path);
    if (manifest === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return new TextEncoder().encode(manifest);
  }
}

function workspaceFolder(): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 };
}

function manifestPath(directory: string): string {
  return `/workspace/.forge/changes/${directory}/manifest.yml`;
}

suite('ForgeChangeDiscovery', () => {
  test('discovers the ID from a valid v1 manifest instead of the directory name', async () => {
    const discovery = new ForgeChangeDiscovery(
      new StubFileSystem(
        [['alpha', vscode.FileType.Directory]],
        new Map([[manifestPath('alpha'), 'schema: forge/change@1\nchange:\n  id: CHG-0001\n']])
      )
    );

    const result = await discovery.discover(workspaceFolder());

    assert.deepStrictEqual(result, {
      kind: 'success',
      changes: [
        {
          id: 'CHG-0001',
          manifestUri: vscode.Uri.file(manifestPath('alpha')),
        },
      ],
    });
  });

  test('discovers a valid v2 manifest', async () => {
    const discovery = new ForgeChangeDiscovery(
      new StubFileSystem(
        [['beta', vscode.FileType.Directory]],
        new Map([[manifestPath('beta'), 'schema: forge/change@2\nchange:\n  id: CHG-0002\n']])
      )
    );

    const result = await discovery.discover(workspaceFolder());

    assert.strictEqual(result.kind, 'success');
    assert.deepStrictEqual(result.kind === 'success' && result.changes.map((change) => change.id), [
      'CHG-0002',
    ]);
  });

  test('returns an empty success when the Changes directory is absent', async () => {
    const discovery = new ForgeChangeDiscovery(
      new StubFileSystem([], new Map(), vscode.FileSystemError.FileNotFound(vscode.Uri.file('/workspace/.forge/changes')))
    );

    assert.deepStrictEqual(await discovery.discover(workspaceFolder()), {
      kind: 'success',
      changes: [],
    });
  });

  test('returns invalid for malformed YAML', async () => {
    const discovery = new ForgeChangeDiscovery(
      new StubFileSystem(
        [['alpha', vscode.FileType.Directory]],
        new Map([[manifestPath('alpha'), 'schema: [']])
      )
    );

    const result = await discovery.discover(workspaceFolder());

    assert.deepStrictEqual(result, { kind: 'invalid', message: 'Change manifest is invalid.' });
  });

  test('returns invalid for unsupported schemas and invalid IDs', async () => {
    for (const manifest of [
      'schema: forge/change@3\nchange:\n  id: CHG-0003\n',
      'schema: forge/change@1\nchange:\n  id: not-a-change\n',
      'schema: forge/change@1\nchange: {}\n',
    ]) {
      const discovery = new ForgeChangeDiscovery(
        new StubFileSystem(
          [['alpha', vscode.FileType.Directory]],
          new Map([[manifestPath('alpha'), manifest]])
        )
      );

      assert.deepStrictEqual(await discovery.discover(workspaceFolder()), {
        kind: 'invalid',
        message: 'Change manifest is invalid.',
      });
    }
  });

  test('returns unavailable when the Changes directory cannot be read', async () => {
    const discovery = new ForgeChangeDiscovery(
      new StubFileSystem([], new Map(), vscode.FileSystemError.NoPermissions(vscode.Uri.file('/workspace/.forge/changes')))
    );

    const result = await discovery.discover(workspaceFolder());

    assert.deepStrictEqual(result, {
      kind: 'unavailable',
      message: 'Change discovery is unavailable.',
    });
  });

  test('returns unavailable when a manifest cannot be read', async () => {
    const discovery = new ForgeChangeDiscovery(
      new StubFileSystem([['alpha', vscode.FileType.Directory]], new Map())
    );

    const result = await discovery.discover(workspaceFolder());

    assert.deepStrictEqual(result, {
      kind: 'unavailable',
      message: 'Change discovery is unavailable.',
    });
  });
});