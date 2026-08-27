import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ForgeExplorerProvider,
  ForgeExplorerItem,
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