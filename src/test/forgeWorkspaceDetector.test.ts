import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  detectForgeWorkspaceFolderState,
  ForgeDetectionState,
  ForgeWorkspaceDetector,
  ForgeWorkspaceSnapshot,
} from '../forge/workspace/ForgeWorkspaceDetector';

function fixtureUri(...segments: string[]): vscode.Uri {
  const extension = vscode.extensions.getExtension('forge-protocol.forge-vscode');
  assert.ok(extension, 'extension should be discoverable');
  return vscode.Uri.joinPath(extension!.extensionUri, 'src', 'test', 'fixtures', ...segments);
}

function workspaceFolder(uri: vscode.Uri, name: string, index = 0): vscode.WorkspaceFolder {
  return { uri, name, index };
}

class StubFileSystemProvider implements vscode.FileSystemProvider {
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  constructor(private readonly statImpl: (uri: vscode.Uri) => vscode.FileStat) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    return this.statImpl(uri);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    // Not needed by these fixtures.
  }

  readFile(): Uint8Array {
    return new Uint8Array();
  }

  writeFile(): void {
    // Not needed by these fixtures.
  }

  delete(): void {
    // Not needed by these fixtures.
  }

  rename(): void {
    // Not needed by these fixtures.
  }
}

async function withStubScheme(
  scheme: string,
  statImpl: (uri: vscode.Uri) => vscode.FileStat,
  use: (root: vscode.Uri) => Promise<void>
): Promise<void> {
  const registration = vscode.workspace.registerFileSystemProvider(
    scheme,
    new StubFileSystemProvider(statImpl),
    { isCaseSensitive: true }
  );
  try {
    await use(vscode.Uri.from({ scheme, path: '/workspace' }));
  } finally {
    registration.dispose();
  }
}

suite('detectForgeWorkspaceFolderState', () => {
  test('returns forge-enabled when .forge/forge.yml is present', async () => {
    const folder = workspaceFolder(fixtureUri('forge-enabled'), 'forge-enabled');
    assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), { kind: 'forge-enabled' });
  });

  test('returns not-forge for an ordinary repository with no .forge/ at all', async () => {
    const folder = workspaceFolder(fixtureUri('plain-repo'), 'plain-repo');
    assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), { kind: 'not-forge' });
  });

  test('returns not-forge when .forge/ exists but forge.yml does not', async () => {
    const folder = workspaceFolder(
      fixtureUri('forge-dir-without-marker'),
      'forge-dir-without-marker'
    );
    assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), { kind: 'not-forge' });
  });

  test('returns not-forge for a folder that does not exist at all', async () => {
    const folder = workspaceFolder(fixtureUri('does-not-exist'), 'does-not-exist');
    assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), { kind: 'not-forge' });
  });

  test('returns not-forge when the marker path exists but is a directory', async () => {
    const folder = workspaceFolder(
      fixtureUri('forge-marker-is-directory'),
      'forge-marker-is-directory'
    );
    assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), { kind: 'not-forge' });
  });

  test('works against non-local URI schemes, not only the local filesystem', async () => {
    await withStubScheme(
      'forge-test-vfs',
      () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 }),
      async (root) => {
        const folder = workspaceFolder(root, 'virtual-workspace');
        assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), {
          kind: 'forge-enabled',
        });
      }
    );
  });

  test('returns unknown with reason indeterminate-file-type when the provider cannot classify the marker', async () => {
    await withStubScheme(
      'forge-test-unknown-file-type',
      () => ({ type: vscode.FileType.Unknown, ctime: 0, mtime: 0, size: 0 }),
      async (root) => {
        const folder = workspaceFolder(root, 'unknown-file-type-workspace');
        assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), {
          kind: 'unknown',
          reason: 'indeterminate-file-type',
        });
      }
    );
  });

  test('returns unknown with reason no-permissions when access is denied', async () => {
    await withStubScheme(
      'forge-test-no-permissions',
      (uri) => {
        throw vscode.FileSystemError.NoPermissions(uri);
      },
      async (root) => {
        const folder = workspaceFolder(root, 'no-permissions-workspace');
        assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), {
          kind: 'unknown',
          reason: 'no-permissions',
        });
      }
    );
  });

  test('returns unknown with reason filesystem-unavailable when the provider is unavailable', async () => {
    await withStubScheme(
      'forge-test-unavailable',
      (uri) => {
        throw vscode.FileSystemError.Unavailable(uri);
      },
      async (root) => {
        const folder = workspaceFolder(root, 'unavailable-workspace');
        assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), {
          kind: 'unknown',
          reason: 'filesystem-unavailable',
        });
      }
    );
  });

  test('returns unknown with reason unexpected-error for any other failure', async () => {
    await withStubScheme(
      'forge-test-unexpected',
      () => {
        throw new Error('boom');
      },
      async (root) => {
        const folder = workspaceFolder(root, 'unexpected-error-workspace');
        assert.deepStrictEqual(await detectForgeWorkspaceFolderState(folder), {
          kind: 'unknown',
          reason: 'unexpected-error',
        });
      }
    );
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

  test('evaluates each multi-root folder independently, propagating the tri-state result', async () => {
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
          snapshot.folders.map((status) => [status.folder.name, status.state.kind]),
        [
          ['forge-enabled', 'forge-enabled'],
          ['plain-repo', 'not-forge'],
        ]
      );
    } finally {
      detector.dispose();
    }
  });

  test('propagates an unknown state for a folder whose marker cannot be accessed', async () => {
    await withStubScheme(
      'forge-test-detector-unknown',
      (uri) => {
        throw vscode.FileSystemError.NoPermissions(uri);
      },
      async (root) => {
        const forgeFolder = workspaceFolder(fixtureUri('forge-enabled'), 'forge-enabled', 0);
        const deniedFolder = workspaceFolder(root, 'denied-workspace', 1);

        const detector = new ForgeWorkspaceDetector({
          getWorkspaceFolders: () => [forgeFolder, deniedFolder],
          onDidChangeWorkspaceFolders: new vscode.EventEmitter<unknown>().event,
        });

        try {
          const snapshot = await detector.refresh();
          assert.strictEqual(snapshot.kind, 'workspace');
          assert.deepStrictEqual(
            snapshot.kind === 'workspace' &&
              snapshot.folders.map((status) => [status.folder.name, status.state]),
            [
              ['forge-enabled', { kind: 'forge-enabled' }],
              ['denied-workspace', { kind: 'unknown', reason: 'no-permissions' }],
            ]
          );
        } finally {
          detector.dispose();
        }
      }
    );
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
      const state: ForgeDetectionState | undefined =
        snapshot.kind === 'workspace' ? snapshot.folders[0]?.state : undefined;
      assert.deepStrictEqual(state, { kind: 'forge-enabled' });
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
