import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ForgeWorkspaceDetector,
  ForgeWorkspaceSnapshot,
  isForgeWorkspaceFolder,
} from '../forge/workspace/ForgeWorkspaceDetector';

function fixtureUri(...segments: string[]): vscode.Uri {
  const extension = vscode.extensions.getExtension('forge-protocol.forge-vscode');
  assert.ok(extension, 'extension should be discoverable');
  return vscode.Uri.joinPath(extension!.extensionUri, 'src', 'test', 'fixtures', ...segments);
}

function workspaceFolder(uri: vscode.Uri, name: string, index = 0): vscode.WorkspaceFolder {
  return { uri, name, index };
}

suite('isForgeWorkspaceFolder', () => {
  test('returns true when .forge/forge.yml is present', async () => {
    const folder = workspaceFolder(fixtureUri('forge-enabled'), 'forge-enabled');
    assert.strictEqual(await isForgeWorkspaceFolder(folder), true);
  });

  test('returns false for an ordinary repository with no .forge/ at all', async () => {
    const folder = workspaceFolder(fixtureUri('plain-repo'), 'plain-repo');
    assert.strictEqual(await isForgeWorkspaceFolder(folder), false);
  });

  test('returns false when .forge/ exists but forge.yml does not', async () => {
    const folder = workspaceFolder(
      fixtureUri('forge-dir-without-marker'),
      'forge-dir-without-marker'
    );
    assert.strictEqual(await isForgeWorkspaceFolder(folder), false);
  });

  test('returns false for a folder that does not exist at all', async () => {
    const folder = workspaceFolder(fixtureUri('does-not-exist'), 'does-not-exist');
    assert.strictEqual(await isForgeWorkspaceFolder(folder), false);
  });

  test('works against non-local URI schemes, not only the local filesystem', async () => {
    const scheme = 'forge-test-vfs';
    const memfs = new (class implements vscode.FileSystemProvider {
      private readonly files = new Map<string, Uint8Array>();
      private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
      readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

      watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
      }

      stat(uri: vscode.Uri): vscode.FileStat {
        if (!this.files.has(uri.path)) {
          throw vscode.FileSystemError.FileNotFound(uri);
        }
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
      }

      readDirectory(): [string, vscode.FileType][] {
        return [];
      }

      createDirectory(): void {
        // No-op: directories are implicit for this fixture provider.
      }

      readFile(): Uint8Array {
        return new Uint8Array();
      }

      writeFile(uri: vscode.Uri, content: Uint8Array): void {
        this.files.set(uri.path, content);
      }

      delete(): void {
        // Not needed by this fixture provider.
      }

      rename(): void {
        // Not needed by this fixture provider.
      }
    })();

    const providerRegistration = vscode.workspace.registerFileSystemProvider(scheme, memfs, {
      isCaseSensitive: true,
    });

    try {
      const root = vscode.Uri.from({ scheme, path: '/workspace' });
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(root, '.forge', 'forge.yml'),
        new Uint8Array()
      );

      const folder = workspaceFolder(root, 'virtual-workspace');
      assert.strictEqual(await isForgeWorkspaceFolder(folder), true);
    } finally {
      providerRegistration.dispose();
    }
  });
});

suite('ForgeWorkspaceDetector', () => {
  test('reports no-workspace before any folders are known', () => {
    const detector = new ForgeWorkspaceDetector({
      getWorkspaceFolders: () => undefined,
      onDidChangeWorkspaceFolders: new vscode.EventEmitter<unknown>().event,
    });

    try {
      assert.deepStrictEqual(detector.getSnapshot(), { kind: 'no-workspace' });
    } finally {
      detector.dispose();
    }
  });

  test('treats an empty folder list the same as no workspace', async () => {
    const detector = new ForgeWorkspaceDetector({
      getWorkspaceFolders: () => [],
      onDidChangeWorkspaceFolders: new vscode.EventEmitter<unknown>().event,
    });

    try {
      const snapshot = await detector.refresh();
      assert.deepStrictEqual(snapshot, { kind: 'no-workspace' });
    } finally {
      detector.dispose();
    }
  });

  test('evaluates each multi-root folder independently', async () => {
    const forgeFolder = workspaceFolder(fixtureUri('forge-enabled'), 'forge-enabled', 0);
    const plainFolder = workspaceFolder(fixtureUri('plain-repo'), 'plain-repo', 1);

    const detector = new ForgeWorkspaceDetector({
      getWorkspaceFolders: () => [forgeFolder, plainFolder],
      onDidChangeWorkspaceFolders: new vscode.EventEmitter<unknown>().event,
    });

    try {
      const snapshot = await detector.refresh();
      assert.strictEqual(snapshot.kind, 'workspace');
      assert.deepStrictEqual(
        snapshot.kind === 'workspace' &&
          snapshot.folders.map((status) => [status.folder.name, status.isForgeEnabled]),
        [
          ['forge-enabled', true],
          ['plain-repo', false],
        ]
      );
    } finally {
      detector.dispose();
    }
  });

  test('re-evaluates when workspace folders change and notifies listeners', async () => {
    let currentFolders: readonly vscode.WorkspaceFolder[] = [];
    const changeEmitter = new vscode.EventEmitter<unknown>();

    const detector = new ForgeWorkspaceDetector({
      getWorkspaceFolders: () => currentFolders,
      onDidChangeWorkspaceFolders: changeEmitter.event,
    });

    const snapshots: ForgeWorkspaceSnapshot[] = [];
    detector.onDidChangeSnapshot((snapshot) => snapshots.push(snapshot));

    try {
      await detector.refresh();
      assert.deepStrictEqual(detector.getSnapshot(), { kind: 'no-workspace' });

      currentFolders = [workspaceFolder(fixtureUri('forge-enabled'), 'forge-enabled')];

      const changeSeen = new Promise<void>((resolve) => {
        const subscription = detector.onDidChangeSnapshot(() => {
          subscription.dispose();
          resolve();
        });
      });
      changeEmitter.fire(undefined);
      await changeSeen;

      const snapshot = detector.getSnapshot();
      assert.strictEqual(snapshot.kind, 'workspace');
      assert.strictEqual(
        snapshot.kind === 'workspace' && snapshot.folders[0]?.isForgeEnabled,
        true
      );
      assert.ok(snapshots.length >= 2, 'listener should observe both the initial and updated snapshot');
    } finally {
      detector.dispose();
    }
  });

  test('stops reacting to workspace folder changes after dispose', async () => {
    let currentFolders: readonly vscode.WorkspaceFolder[] = [];
    const changeEmitter = new vscode.EventEmitter<unknown>();

    const detector = new ForgeWorkspaceDetector({
      getWorkspaceFolders: () => currentFolders,
      onDidChangeWorkspaceFolders: changeEmitter.event,
    });

    await detector.refresh();
    detector.dispose();

    currentFolders = [workspaceFolder(fixtureUri('forge-enabled'), 'forge-enabled')];
    assert.doesNotThrow(() => changeEmitter.fire(undefined));
    assert.deepStrictEqual(detector.getSnapshot(), { kind: 'no-workspace' });
  });
});
