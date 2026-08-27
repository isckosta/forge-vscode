import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ForgeExplorerProvider,
  ForgeExplorerItem,
} from '../views/ForgeExplorerProvider';
import {
  ForgeWorkspaceSnapshot,
} from '../forge/workspace/ForgeWorkspaceDetector';

function workspaceFolder(name: string, index = 0): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.parse(`file:/${name}`), name, index };
}

suite('ForgeExplorerProvider', () => {
  test('projects no-workspace as an explicit tree item', () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    const provider = new ForgeExplorerProvider({
      getSnapshot: () => ({ kind: 'no-workspace' }),
      onDidChangeSnapshot: snapshotEmitter.event,
    });

    try {
      const [item] = provider.getChildren();
      assert.ok(item);
      assert.strictEqual(item.label, 'No workspace open');
      assert.strictEqual(item.contextValue, 'no-workspace');
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });

  test('projects every workspace folder and preserves unknown reasons', () => {
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
      const items = provider.getChildren();
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

  test('refreshes the tree when the detector publishes a snapshot', () => {
    const snapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
    let snapshot: ForgeWorkspaceSnapshot = { kind: 'no-workspace' };
    const provider = new ForgeExplorerProvider({
      getSnapshot: () => snapshot,
      onDidChangeSnapshot: snapshotEmitter.event,
    });
    const changes: ForgeExplorerItem[][] = [];
    provider.onDidChangeTreeData(() => changes.push(provider.getChildren()));

    try {
      snapshot = {
        kind: 'workspace',
        folders: [{ folder: workspaceFolder('updated'), state: { kind: 'forge-enabled' } }],
      };
      snapshotEmitter.fire(snapshot);

      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0]?.[0]?.label, 'updated');
    } finally {
      provider.dispose();
      snapshotEmitter.dispose();
    }
  });
});