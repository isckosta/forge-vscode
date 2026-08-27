import * as vscode from 'vscode';
import {
  ForgeDetectionFailureReason,
  ForgeWorkspaceSnapshot,
} from '../forge/workspace/ForgeWorkspaceDetector';

export interface ForgeWorkspaceSnapshotSource {
  readonly onDidChangeSnapshot: vscode.Event<ForgeWorkspaceSnapshot>;
  getSnapshot(): ForgeWorkspaceSnapshot;
}

export class ForgeExplorerItem extends vscode.TreeItem {
  constructor(
    label: string,
    contextValue: 'forge-enabled' | 'not-forge' | 'unknown' | 'no-workspace',
    description?: string,
    iconId?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = contextValue;
    this.description = description;
    this.iconPath = iconId ? new vscode.ThemeIcon(iconId) : undefined;
  }
}

const UNKNOWN_REASON_LABELS: Readonly<Record<ForgeDetectionFailureReason, string>> = {
  'no-permissions': 'no permissions',
  'filesystem-unavailable': 'filesystem unavailable',
  'indeterminate-file-type': 'indeterminate file type',
  'unexpected-error': 'unexpected error',
};

export class ForgeExplorerProvider
  implements vscode.TreeDataProvider<ForgeExplorerItem>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    ForgeExplorerItem | undefined
  >();
  private readonly snapshotSubscription: vscode.Disposable;
  private snapshot: ForgeWorkspaceSnapshot;

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(source: ForgeWorkspaceSnapshotSource) {
    this.snapshot = source.getSnapshot();
    this.snapshotSubscription = source.onDidChangeSnapshot((snapshot) => {
      this.snapshot = snapshot;
      this.onDidChangeTreeDataEmitter.fire(undefined);
    });
  }

  getTreeItem(item: ForgeExplorerItem): vscode.TreeItem {
    return item;
  }

  getChildren(element?: ForgeExplorerItem): ForgeExplorerItem[] {
    if (element) {
      return [];
    }

    if (this.snapshot.kind === 'no-workspace') {
      return [
        new ForgeExplorerItem('No workspace open', 'no-workspace', undefined, 'folder-opened'),
      ];
    }

    return this.snapshot.folders.map(({ folder, state }) => {
      switch (state.kind) {
        case 'forge-enabled':
          return new ForgeExplorerItem(folder.name, 'forge-enabled', 'Forge enabled', 'pass');
        case 'not-forge':
          return new ForgeExplorerItem(folder.name, 'not-forge', 'Not Forge', 'circle-slash');
        case 'unknown':
          return new ForgeExplorerItem(
            folder.name,
            'unknown',
            `Unknown: ${UNKNOWN_REASON_LABELS[state.reason]}`,
            'question'
          );
      }
    });
  }

  dispose(): void {
    this.snapshotSubscription.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }
}