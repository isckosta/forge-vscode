import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ForgeExplorerProvider,
  ForgeExplorerItem,
  ForgeFileSystemWatcherFactory,
  ForgeWorkspaceSnapshotSource,
} from '../views/ForgeExplorerProvider';
import {
  ForgeWorkspaceSnapshot,
} from '../forge/workspace/ForgeWorkspaceDetector';
import { ForgeChangeDiscoveryResult } from '../forge/changes/ForgeChangeDiscovery';

interface StubChangeDiscovery {
  discover(folder: vscode.WorkspaceFolder): Promise<ForgeChangeDiscoveryResult>;
}

function workspaceFolder(name: string, index = 0): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.parse(`file:/${name}`), name, index };
}

suite('ForgeExplorerProvider', () => {
  test('refreshes only the affected workspace on filesystem refresh', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const watcherEvents = new Map<string, vscode.EventEmitter<vscode.Uri>>();
    const folders = [workspaceFolder('first'), workspaceFolder('second', 1)];
    const ids = new Map(folders.map((folder) => [folder.name, 'CHG-0001']));
    const discovered: StubChangeDiscovery = {
      discover: async (folder) => ({
        kind: 'success',
        changes: [{ id: ids.get(folder.name)!, manifestUri: folder.uri }],
      }),
    };
    const watcherFactory = {
      createFileSystemWatcher: (pattern: vscode.GlobPattern): vscode.FileSystemWatcher => {
        const events = new vscode.EventEmitter<vscode.Uri>();
        const patternKey =
          pattern instanceof vscode.RelativePattern
            ? vscode.Uri.joinPath(pattern.baseUri, pattern.pattern).toString()
            : pattern.toString();
        watcherEvents.set(patternKey, events);
        return {
          onDidCreate: events.event,
          onDidChange: events.event,
          onDidDelete: events.event,
          ignoreCreateEvents: false,
          ignoreChangeEvents: false,
          ignoreDeleteEvents: false,
          dispose: () => events.dispose(),
        };
      },
    };
    const provider = new (ForgeExplorerProvider as unknown as new (
      source: ForgeWorkspaceSnapshotSource,
      discovery: StubChangeDiscovery,
      watcherFactory: {
        createFileSystemWatcher: (pattern: vscode.GlobPattern) => vscode.FileSystemWatcher;
      }
    ) => ForgeExplorerProvider)(
      {
        getSnapshot: () => ({
          kind: 'workspace',
          folders: folders.map((folder) => ({
            folder,
            state: { kind: 'forge-enabled' as const },
          })),
        }),
        onDidChangeSnapshot: snapshotEmitter.event,
      },
      discovered,
      watcherFactory
    );

    try {
      const workspaces = await provider.getChildren();
      const firstWorkspace = workspaces[0];
      assert.ok(firstWorkspace);
      const changes = await Promise.all(workspaces.map((workspace) => provider.getChildren(workspace)));
      const changeSections = changes.map(([item]) => item);
      assert.ok(changeSections[0]);
      assert.ok(changeSections[1]);
      assert.deepStrictEqual((await provider.getChildren(changeSections[0])).map((item) => item.label), [
        'CHG-0001',
      ]);
      assert.deepStrictEqual((await provider.getChildren(changeSections[1])).map((item) => item.label), [
        'CHG-0001',
      ]);

      let refreshCount = 0;
      let refreshedItem: ForgeExplorerItem | undefined;
      const refreshed = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData((item) => {
          refreshCount += 1;
          refreshedItem = item;
          resolve();
        });
      });
      ids.set('first', 'CHG-0002');
      const firstChangesPath = vscode.Uri.joinPath(folders[0]!.uri, '.forge', 'changes', '**');
      watcherEvents.get(firstChangesPath.toString())?.fire(vscode.Uri.joinPath(folders[0]!.uri, 'manifest.yml'));
      await Promise.race([
        refreshed,
        new Promise<void>((resolve) => setImmediate(resolve)),
      ]);

      assert.strictEqual(refreshCount, 1);
  assert.strictEqual(refreshedItem?.folderUri?.toString(), folders[0]!.uri.toString());
      assert.strictEqual(refreshedItem, firstWorkspace);
      assert.deepStrictEqual((await provider.getChildren(changeSections[0])).map((item) => item.label), [
        'CHG-0002',
      ]);
      assert.deepStrictEqual((await provider.getChildren(changeSections[1])).map((item) => item.label), [
        'CHG-0001',
      ]);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('replays a filesystem refresh that arrives during discovery', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const folder = workspaceFolder('changing');
    const watcherEvents = new vscode.EventEmitter<vscode.Uri>();
    const watcherFactory = {
      createFileSystemWatcher: (): vscode.FileSystemWatcher => ({
        onDidCreate: watcherEvents.event,
        onDidChange: watcherEvents.event,
        onDidDelete: watcherEvents.event,
        ignoreCreateEvents: false,
        ignoreChangeEvents: false,
        ignoreDeleteEvents: false,
        dispose: () => watcherEvents.dispose(),
      }),
    };
    const pending: Array<(result: ForgeChangeDiscoveryResult) => void> = [];
    let calls = 0;
    const discovered: StubChangeDiscovery = {
      discover: async () => {
        calls += 1;
        if (calls === 1) {
          return { kind: 'success', changes: [{ id: 'CHG-0001', manifestUri: folder.uri }] };
        }
        return new Promise<ForgeChangeDiscoveryResult>((resolve) => pending.push(resolve));
      },
    };
    const provider = new (ForgeExplorerProvider as unknown as new (
      source: ForgeWorkspaceSnapshotSource,
      discovery: StubChangeDiscovery,
      watcherFactory: ForgeFileSystemWatcherFactory
    ) => ForgeExplorerProvider)(
      {
        getSnapshot: () => ({
          kind: 'workspace',
          folders: [{ folder, state: { kind: 'forge-enabled' as const } }],
        }),
        onDidChangeSnapshot: snapshotEmitter.event,
      },
      discovered,
      watcherFactory
    );

    try {
      const [workspace] = await provider.getChildren();
      assert.ok(workspace);
      await provider.getChildren(workspace);

      let refreshCount = 0;
      provider.onDidChangeTreeData(() => {
        refreshCount += 1;
      });
      watcherEvents.fire(vscode.Uri.joinPath(folder.uri, 'first-change'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      watcherEvents.fire(vscode.Uri.joinPath(folder.uri, 'second-change'));
      assert.strictEqual(calls, 2);

      pending[0]?.({ kind: 'success', changes: [{ id: 'CHG-0002', manifestUri: folder.uri }] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(calls, 3);
      pending[1]?.({ kind: 'success', changes: [{ id: 'CHG-0003', manifestUri: folder.uri }] });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(refreshCount, 1);
      const [changes] = await provider.getChildren(workspace);
      assert.ok(changes);
      assert.deepStrictEqual(
        (await provider.getChildren(changes)).map((item) => item.label),
        ['CHG-0003']
      );
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('replays a pending filesystem event after an enabled snapshot change', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const folder = workspaceFolder('snapshot-changing');
    const watcherEvents = new vscode.EventEmitter<vscode.Uri>();
    const watcherFactory = {
      createFileSystemWatcher: (): vscode.FileSystemWatcher => ({
        onDidCreate: watcherEvents.event,
        onDidChange: watcherEvents.event,
        onDidDelete: watcherEvents.event,
        ignoreCreateEvents: false,
        ignoreChangeEvents: false,
        ignoreDeleteEvents: false,
        dispose: () => watcherEvents.dispose(),
      }),
    };
    const pending: Array<(result: ForgeChangeDiscoveryResult) => void> = [];
    let calls = 0;
    const discovered: StubChangeDiscovery = {
      discover: async () => {
        calls += 1;
        if (calls === 1) {
          return { kind: 'success', changes: [{ id: 'CHG-0001', manifestUri: folder.uri }] };
        }
        return new Promise<ForgeChangeDiscoveryResult>((resolve) => pending.push(resolve));
      },
    };
    let snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [{ folder, state: { kind: 'forge-enabled' } }],
    };
    const provider = new ForgeExplorerProvider(
      {
        getSnapshot: () => snapshot,
        onDidChangeSnapshot: snapshotEmitter.event,
      },
      discovered,
      watcherFactory
    );

    try {
      const [workspace] = await provider.getChildren();
      assert.ok(workspace);
      await provider.getChildren(workspace);

      let targetedRefreshes = 0;
      provider.onDidChangeTreeData((item) => {
        if (item?.folderUri?.toString() === folder.uri.toString()) {
          targetedRefreshes += 1;
        }
      });
      watcherEvents.fire(vscode.Uri.joinPath(folder.uri, 'first-change'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      watcherEvents.fire(vscode.Uri.joinPath(folder.uri, 'second-change'));

      snapshot = {
        kind: 'workspace',
        folders: [{ folder, state: { kind: 'forge-enabled' } }],
      };
      snapshotEmitter.fire(snapshot);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(calls, 3);

      pending[0]?.({ kind: 'success', changes: [{ id: 'CHG-0002', manifestUri: folder.uri }] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(calls, 4);

      pending[1]?.({ kind: 'success', changes: [{ id: 'CHG-0003', manifestUri: folder.uri }] });
      pending[2]?.({ kind: 'success', changes: [{ id: 'CHG-0004', manifestUri: folder.uri }] });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(targetedRefreshes, 1);
      const [changes] = await provider.getChildren(workspace);
      assert.ok(changes);
      assert.deepStrictEqual((await provider.getChildren(changes)).map((item) => item.label), [
        'CHG-0004',
      ]);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('does not let an older concurrent discovery overwrite a filesystem result', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const folder = workspaceFolder('concurrent');
    const watcherEvents = new vscode.EventEmitter<vscode.Uri>();
    const watcherFactory = {
      createFileSystemWatcher: (): vscode.FileSystemWatcher => ({
        onDidCreate: () => new vscode.Disposable(() => {}),
        onDidChange: watcherEvents.event,
        onDidDelete: () => new vscode.Disposable(() => {}),
        ignoreCreateEvents: false,
        ignoreChangeEvents: false,
        ignoreDeleteEvents: false,
        dispose: () => watcherEvents.dispose(),
      }),
    };
    const pending: Array<(result: ForgeChangeDiscoveryResult) => void> = [];
    let calls = 0;
    const discovered: StubChangeDiscovery = {
      discover: async () => {
        calls += 1;
        return new Promise<ForgeChangeDiscoveryResult>((resolve) => pending.push(resolve));
      },
    };
    const provider = new ForgeExplorerProvider(
      {
        getSnapshot: () => ({
          kind: 'workspace',
          folders: [{ folder, state: { kind: 'forge-enabled' } }],
        }),
        onDidChangeSnapshot: snapshotEmitter.event,
      },
      discovered,
      watcherFactory
    );

    try {
      const [workspace] = await provider.getChildren();
      assert.ok(workspace);
      void provider.getChildren(workspace);
      await new Promise<void>((resolve) => setImmediate(resolve));
      watcherEvents.fire(vscode.Uri.joinPath(folder.uri, 'changed'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.strictEqual(calls, 2);

      pending[1]?.({ kind: 'success', changes: [{ id: 'CHG-0003', manifestUri: folder.uri }] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      pending[0]?.({ kind: 'success', changes: [{ id: 'CHG-0002', manifestUri: folder.uri }] });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const [changes] = await provider.getChildren(workspace);
      assert.ok(changes);
      assert.deepStrictEqual((await provider.getChildren(changes)).map((item) => item.label), [
        'CHG-0003',
      ]);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('projects no-workspace as an explicit tree item', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const provider = new ForgeExplorerProvider({
      getSnapshot: () => ({ kind: 'no-workspace' }),
      onDidChangeSnapshot: snapshotEmitter.event,
    });

    try {
      const [item] = await provider.getChildren();
      assert.ok(item);
      assert.strictEqual(item.label, 'No workspace open');
      assert.strictEqual(item.contextValue, 'no-workspace');
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('projects every workspace folder and preserves unknown reasons', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [
        { folder: workspaceFolder('enabled'), state: { kind: 'forge-enabled' } },
        { folder: workspaceFolder('plain', 1), state: { kind: 'not-forge' } },
        {
          folder: workspaceFolder('uncertain', 2),
          state: { kind: 'unknown', reason: 'no-permissions' },
        },
      ],
    };
    const provider = new ForgeExplorerProvider({
      getSnapshot: () => snapshot,
      onDidChangeSnapshot: snapshotEmitter.event,
    });

    try {
      const items = await provider.getChildren();
      assert.deepStrictEqual(
        items.map((item) => [item.label, item.description, item.contextValue]),
        [
          ['enabled', 'Forge enabled', 'forge-enabled'],
          ['plain', 'Not Forge', 'not-forge'],
          ['uncertain', 'Unknown: no permissions', 'unknown'],
        ]
      );
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('projects discovered change IDs under a Changes section', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [{ folder: workspaceFolder('enabled'), state: { kind: 'forge-enabled' } }],
    };
    const discovered: StubChangeDiscovery = {
      discover: async () => ({
        kind: 'success',
        changes: [
          { id: 'CHG-0002', manifestUri: vscode.Uri.file('/enabled/second') },
          { id: 'CHG-0001', manifestUri: vscode.Uri.file('/enabled/first') },
        ],
      }),
    };
    const provider = new ForgeExplorerProvider(
      { getSnapshot: () => snapshot, onDidChangeSnapshot: snapshotEmitter.event },
      discovered
    );

    try {
      const [workspace] = await provider.getChildren();
      assert.ok(workspace);
      const [changes] = await provider.getChildren(workspace);
      assert.ok(changes);
      assert.strictEqual(changes.label, 'Changes');
      const changeItems = await provider.getChildren(changes);
      assert.deepStrictEqual(changeItems.map((item) => item.label), ['CHG-0002', 'CHG-0001']);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('projects empty, unavailable, and invalid discovery results explicitly', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const folders = ['empty', 'unavailable', 'invalid'].map((name, index) => ({
      folder: workspaceFolder(name, index),
      state: { kind: 'forge-enabled' as const },
    }));
    const results: Record<string, ForgeChangeDiscoveryResult> = {
      empty: { kind: 'success', changes: [] },
      unavailable: { kind: 'unavailable', message: 'Change discovery is unavailable.' },
      invalid: { kind: 'invalid', message: 'Change manifest is invalid.' },
    };
    const discovered: StubChangeDiscovery = {
      discover: async (folder) => results[folder.name]!,
    };
    const provider = new ForgeExplorerProvider(
      {
        getSnapshot: () => ({ kind: 'workspace', folders }),
        onDidChangeSnapshot: snapshotEmitter.event,
      },
      discovered
    );

    try {
      const workspaces = await provider.getChildren();
      for (const workspace of workspaces) {
        const [changes] = await provider.getChildren(workspace);
        assert.ok(changes);
        const [state] = await provider.getChildren(changes);
        assert.ok(state);
        assert.strictEqual(
          state.contextValue,
          workspace.label === 'empty'
            ? 'changes-empty'
            : workspace.label === 'unavailable'
              ? 'changes-unavailable'
              : 'changes-invalid'
        );
        if (workspace.label === 'empty') {
          assert.strictEqual(state.label, 'No Changes found');
        }
      }
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('does not discover changes for not-forge or unknown folders', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const calls: string[] = [];
    const discovered: StubChangeDiscovery = {
      discover: async (folder) => {
        calls.push(folder.name);
        return { kind: 'success', changes: [] };
      },
    };
    const snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [
        { folder: workspaceFolder('plain'), state: { kind: 'not-forge' } },
        {
          folder: workspaceFolder('unknown', 1),
          state: { kind: 'unknown', reason: 'unexpected-error' },
        },
      ],
    };
    const provider = new ForgeExplorerProvider(
      { getSnapshot: () => snapshot, onDidChangeSnapshot: snapshotEmitter.event },
      discovered
    );

    try {
      const items = await provider.getChildren();
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(
        (await Promise.all(items.map((item) => provider.getChildren(item)))).map(
          (children) => children.length
        ),
        [0, 0]
      );
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('rejects stale tree access after an enabled folder becomes not-forge', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    let snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [{ folder: workspaceFolder('enabled'), state: { kind: 'forge-enabled' } }],
    };
    const calls: string[] = [];
    const discovered: StubChangeDiscovery = {
      discover: async (folder) => {
        calls.push(folder.name);
        return {
          kind: 'success',
          changes: [{ id: 'CHG-0001', manifestUri: folder.uri }],
        };
      },
    };
    const provider = new ForgeExplorerProvider(
      { getSnapshot: () => snapshot, onDidChangeSnapshot: snapshotEmitter.event },
      discovered
    );

    try {
      const [workspace] = await provider.getChildren();
      assert.ok(workspace);
      const [changes] = await provider.getChildren(workspace);
      assert.ok(changes);
      assert.deepStrictEqual((await provider.getChildren(changes)).map((item) => item.label), [
        'CHG-0001',
      ]);

      snapshot = {
        kind: 'workspace',
        folders: [{ folder: workspaceFolder('enabled'), state: { kind: 'not-forge' } }],
      };
      const refreshed = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => resolve());
      });
      snapshotEmitter.fire(snapshot);
      await refreshed;

      assert.deepStrictEqual(await provider.getChildren(workspace), []);
      assert.deepStrictEqual(await provider.getChildren(changes), []);
      assert.deepStrictEqual(calls, ['enabled']);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('keeps simultaneous enabled roots independent for success and failure results', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const folders = [workspaceFolder('success'), workspaceFolder('failure', 1)];
    const discovered: StubChangeDiscovery = {
      discover: async (folder) =>
        folder.name === 'success'
          ? { kind: 'success', changes: [{ id: 'CHG-0001', manifestUri: folder.uri }] }
          : { kind: 'invalid', message: 'Change manifest is invalid.' },
    };
    const provider = new ForgeExplorerProvider(
      {
        getSnapshot: () => ({
          kind: 'workspace',
          folders: folders.map((folder) => ({
            folder,
            state: { kind: 'forge-enabled' as const },
          })),
        }),
        onDidChangeSnapshot: snapshotEmitter.event,
      },
      discovered
    );

    try {
      const workspaces = await provider.getChildren();
      const changes = await Promise.all(workspaces.map((workspace) => provider.getChildren(workspace)));
      const changeItems = await Promise.all(changes.map(([item]) => provider.getChildren(item)));

      assert.deepStrictEqual(changeItems.map((items) => items.map((item) => item.label)), [
        ['CHG-0001'],
        ['Changes invalid'],
      ]);
      assert.deepStrictEqual(changeItems.map((items) => items[0]?.contextValue), [
        'change',
        'changes-invalid',
      ]);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('clears a removed folder cache before a URI is reused', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const folder = workspaceFolder('removed');
    let snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [{ folder, state: { kind: 'forge-enabled' } }],
    };
    let callCount = 0;
    const discovered: StubChangeDiscovery = {
      discover: async () => {
        callCount += 1;
        return {
          kind: 'success',
          changes: [{ id: `CHG-000${callCount}`, manifestUri: folder.uri }],
        };
      },
    };
    const provider = new ForgeExplorerProvider(
      { getSnapshot: () => snapshot, onDidChangeSnapshot: snapshotEmitter.event },
      discovered
    );

    try {
      const [workspace] = await provider.getChildren();
      assert.ok(workspace);
      await provider.getChildren(workspace);

      snapshot = { kind: 'no-workspace' };
      const refreshed = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => resolve());
      });
      snapshotEmitter.fire(snapshot);
      await refreshed;

      snapshot = {
        kind: 'workspace',
        folders: [{ folder, state: { kind: 'forge-enabled' } }],
      };
      const readded = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => resolve());
      });
      snapshotEmitter.fire(snapshot);
      await readded;

      const [reusedWorkspace] = await provider.getChildren();
      assert.ok(reusedWorkspace);
      await provider.getChildren(reusedWorkspace);
      assert.strictEqual(callCount, 2);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('does not cache or expose a discovery resolved after enablement is lost', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const folder = workspaceFolder('reused');
    let snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [{ folder, state: { kind: 'forge-enabled' } }],
    };
    let callCount = 0;
    const resolveDiscoveries: Array<(result: ForgeChangeDiscoveryResult) => void> = [];
    const discovered: StubChangeDiscovery = {
      discover: async () => {
        callCount += 1;
        return new Promise<ForgeChangeDiscoveryResult>((resolve) => {
          resolveDiscoveries.push(resolve);
        });
      },
    };
    const provider = new ForgeExplorerProvider(
      { getSnapshot: () => snapshot, onDidChangeSnapshot: snapshotEmitter.event },
      discovered
    );

    try {
      const [workspace] = await provider.getChildren();
      assert.ok(workspace);
      const pendingChanges = provider.getChildren(workspace);

      snapshot = {
        kind: 'workspace',
        folders: [{ folder, state: { kind: 'not-forge' } }],
      };
      const disabled = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => resolve());
      });
      snapshotEmitter.fire(snapshot);
      await disabled;

      resolveDiscoveries[0]?.({
        kind: 'success',
        changes: [{ id: 'CHG-OLD', manifestUri: folder.uri }],
      });
      assert.deepStrictEqual(await pendingChanges, []);

      snapshot = {
        kind: 'workspace',
        folders: [{ folder, state: { kind: 'forge-enabled' } }],
      };
      const reenabled = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => resolve());
      });
      snapshotEmitter.fire(snapshot);
      assert.strictEqual(callCount, 2);
      resolveDiscoveries[1]?.({
        kind: 'success',
        changes: [{ id: 'CHG-NEW', manifestUri: folder.uri }],
      });
      await reenabled;
      assert.strictEqual(callCount, 2);

      const [reenabledWorkspace] = await provider.getChildren();
      assert.ok(reenabledWorkspace);
      const [reenabledChanges] = await provider.getChildren(reenabledWorkspace);
      assert.ok(reenabledChanges);
      assert.deepStrictEqual(
        (await provider.getChildren(reenabledChanges)).map((item) => item.label),
        ['CHG-NEW']
      );
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('rejects a pending Changes expansion after disable and re-enable', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const folder = workspaceFolder('pending');
    let snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [{ folder, state: { kind: 'forge-enabled' } }],
    };
    let callCount = 0;
    const resolveDiscoveries: Array<(result: ForgeChangeDiscoveryResult) => void> = [];
    const discovered: StubChangeDiscovery = {
      discover: async () => {
        callCount += 1;
        return new Promise<ForgeChangeDiscoveryResult>((resolve) => {
          resolveDiscoveries.push(resolve);
        });
      },
    };
    const provider = new ForgeExplorerProvider(
      { getSnapshot: () => snapshot, onDidChangeSnapshot: snapshotEmitter.event },
      discovered
    );

    try {
      const changes = new ForgeExplorerItem(
        'Changes',
        'changes',
        undefined,
        'list-tree',
        'changes',
        folder.uri,
        vscode.TreeItemCollapsibleState.Collapsed
      );

      const pendingChangeItems = provider.getChildren(changes);
      snapshot = {
        kind: 'workspace',
        folders: [{ folder, state: { kind: 'not-forge' } }],
      };
      const disabled = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => resolve());
      });
      snapshotEmitter.fire(snapshot);
      await disabled;

      snapshot = {
        kind: 'workspace',
        folders: [{ folder, state: { kind: 'forge-enabled' } }],
      };
      const reenabled = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => resolve());
      });
      snapshotEmitter.fire(snapshot);
      assert.strictEqual(callCount, 2);

      resolveDiscoveries[0]?.({
        kind: 'success',
        changes: [{ id: 'CHG-OLD', manifestUri: folder.uri }],
      });
      assert.deepStrictEqual(await pendingChangeItems, []);

      resolveDiscoveries[1]?.({
        kind: 'success',
        changes: [{ id: 'CHG-NEW', manifestUri: folder.uri }],
      });
      await reenabled;
      assert.deepStrictEqual(
        (await provider.getChildren(changes)).map((item) => item.label),
        ['CHG-NEW']
      );
      assert.strictEqual(callCount, 2);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('rejects a pending workspace expansion after disable and re-enable', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const folder = workspaceFolder('pending-workspace');
    let snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [{ folder, state: { kind: 'forge-enabled' } }],
    };
    let callCount = 0;
    const resolveDiscoveries: Array<(result: ForgeChangeDiscoveryResult) => void> = [];
    const discovered: StubChangeDiscovery = {
      discover: async () => {
        callCount += 1;
        return new Promise<ForgeChangeDiscoveryResult>((resolve) => {
          resolveDiscoveries.push(resolve);
        });
      },
    };
    const provider = new ForgeExplorerProvider(
      { getSnapshot: () => snapshot, onDidChangeSnapshot: snapshotEmitter.event },
      discovered
    );

    try {
      const [workspace] = await provider.getChildren();
      assert.ok(workspace);
      const pendingChanges = provider.getChildren(workspace);

      snapshot = {
        kind: 'workspace',
        folders: [{ folder, state: { kind: 'not-forge' } }],
      };
      const disabled = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => resolve());
      });
      snapshotEmitter.fire(snapshot);
      await disabled;

      snapshot = {
        kind: 'workspace',
        folders: [{ folder, state: { kind: 'forge-enabled' } }],
      };
      const reenabled = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => resolve());
      });
      snapshotEmitter.fire(snapshot);
      assert.strictEqual(callCount, 2);

      resolveDiscoveries[0]?.({
        kind: 'success',
        changes: [{ id: 'CHG-OLD', manifestUri: folder.uri }],
      });
      assert.deepStrictEqual(await pendingChanges, []);

      resolveDiscoveries[1]?.({
        kind: 'success',
        changes: [{ id: 'CHG-NEW', manifestUri: folder.uri }],
      });
      await reenabled;

      const [reenabledWorkspace] = await provider.getChildren();
      assert.ok(reenabledWorkspace);
      const [changes] = await provider.getChildren(reenabledWorkspace);
      assert.ok(changes);
      assert.deepStrictEqual((await provider.getChildren(changes)).map((item) => item.label), [
        'CHG-NEW',
      ]);
      assert.strictEqual(callCount, 2);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('caches enabled-folder results and refreshes the projection independently', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    let snapshot: ForgeWorkspaceSnapshot = {
      kind: 'workspace',
      folders: [{ folder: workspaceFolder('first'), state: { kind: 'forge-enabled' } }],
    };
    const calls: string[] = [];
    const discovered: StubChangeDiscovery = {
      discover: async (folder) => {
        calls.push(folder.name);
        return {
          kind: 'success',
          changes: [{ id: `CHG-${folder.index + 1}`, manifestUri: folder.uri }],
        };
      },
    };
    const provider = new ForgeExplorerProvider(
      { getSnapshot: () => snapshot, onDidChangeSnapshot: snapshotEmitter.event },
      discovered
    );

    try {
      const [first] = await provider.getChildren();
      assert.ok(first);
      await provider.getChildren(first);
      await provider.getChildren(first);
      assert.deepStrictEqual(calls, ['first']);

      let refreshCount = 0;
      const refreshed = new Promise<void>((resolve) => {
        provider.onDidChangeTreeData(() => {
          refreshCount += 1;
          resolve();
        });
      });
      snapshot = {
        kind: 'workspace',
        folders: [
          { folder: workspaceFolder('second'), state: { kind: 'forge-enabled' } },
          { folder: workspaceFolder('plain', 1), state: { kind: 'not-forge' } },
        ],
      };
      snapshotEmitter.fire(snapshot);
      await refreshed;

      const workspaces = await provider.getChildren();
      assert.deepStrictEqual(workspaces.map((item) => item.label), ['second', 'plain']);
      await provider.getChildren(workspaces[0]);
      assert.deepStrictEqual(calls, ['first', 'second']);
      assert.strictEqual(refreshCount, 1);
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('refreshes the tree when the detector publishes a snapshot', async () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    let snapshot: ForgeWorkspaceSnapshot = { kind: 'no-workspace' };
    const provider = new ForgeExplorerProvider({
      getSnapshot: () => snapshot,
      onDidChangeSnapshot: snapshotEmitter.event,
    });
    const changes: ForgeExplorerItem[][] = [];
    let resolveRefresh: (() => void) | undefined;
    const refresh = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    provider.onDidChangeTreeData(() => {
      changes.push(provider.getChildren() as ForgeExplorerItem[]);
      resolveRefresh?.();
    });

    try {
      snapshot = {
        kind: 'workspace',
        folders: [{ folder: workspaceFolder('updated'), state: { kind: 'forge-enabled' } }],
      };
      snapshotEmitter.fire(snapshot);
      await refresh;

      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0]?.[0]?.label, 'updated');
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });
});