import * as vscode from 'vscode';
import {
  ForgeDetectionFailureReason,
  ForgeWorkspaceSnapshot,
} from '../forge/workspace/ForgeWorkspaceDetector';
import {
  ForgeChangeDiscovery,
  ForgeChangeDiscoveryResult,
} from '../forge/changes/ForgeChangeDiscovery';

export interface ForgeWorkspaceSnapshotSource {
  readonly onDidChangeSnapshot: vscode.Event<ForgeWorkspaceSnapshot>;
  getSnapshot(): ForgeWorkspaceSnapshot;
}

export interface ForgeChangeDiscoverySource {
  discover(folder: vscode.WorkspaceFolder): Promise<ForgeChangeDiscoveryResult>;
}

type ForgeExplorerItemKind = 'workspace' | 'changes' | 'change' | 'state' | 'status';

export class ForgeExplorerItem extends vscode.TreeItem {
  readonly kind: ForgeExplorerItemKind;
  readonly folderUri?: vscode.Uri;

  constructor(
    label: string,
    contextValue:
      | 'forge-enabled'
      | 'not-forge'
      | 'unknown'
      | 'no-workspace'
      | 'changes'
      | 'change'
      | 'changes-empty'
      | 'changes-unavailable'
      | 'changes-invalid',
    description?: string,
    iconId?: string,
    kind: ForgeExplorerItemKind = 'status',
    folderUri?: vscode.Uri,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    this.description = description;
    this.iconPath = iconId ? new vscode.ThemeIcon(iconId) : undefined;
    this.kind = kind;
    this.folderUri = folderUri;
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
  private readonly discovery: ForgeChangeDiscoverySource;
  private readonly discoveryResults = new Map<string, ForgeChangeDiscoveryResult>();
  private snapshot: ForgeWorkspaceSnapshot;

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(source: ForgeWorkspaceSnapshotSource, discovery: ForgeChangeDiscoverySource = new ForgeChangeDiscovery()) {
    this.discovery = discovery;
    this.snapshot = source.getSnapshot();
    this.snapshotSubscription = source.onDidChangeSnapshot((snapshot) => {
      void this.refreshProjection(snapshot);
    });
  }

  getTreeItem(item: ForgeExplorerItem): vscode.TreeItem {
    return item;
  }

  getChildren(element?: ForgeExplorerItem): ForgeExplorerItem[] | Thenable<ForgeExplorerItem[]> {
    if (element) {
      if (element.kind === 'workspace' && element.folderUri) {
        return this.getChanges(element.folderUri);
      }
      if (element.kind === 'changes' && element.folderUri) {
        return this.getChangeItems(element.folderUri);
      }
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
          return new ForgeExplorerItem(
            folder.name,
            'forge-enabled',
            'Forge enabled',
            'pass',
            'workspace',
            folder.uri,
            vscode.TreeItemCollapsibleState.Collapsed
          );
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

  private async getChanges(folderUri: vscode.Uri): Promise<ForgeExplorerItem[]> {
    await this.discoverFor(folderUri);
    return [
      new ForgeExplorerItem(
        'Changes',
        'changes',
        undefined,
        'list-tree',
        'changes',
        folderUri,
        vscode.TreeItemCollapsibleState.Collapsed
      ),
    ];
  }

  private async getChangeItems(folderUri: vscode.Uri): Promise<ForgeExplorerItem[]> {
    const result = await this.discoverFor(folderUri);
    if (result.kind === 'success') {
      if (result.changes.length === 0) {
        return [new ForgeExplorerItem('No changes', 'changes-empty', undefined, 'info')];
      }
      return result.changes.map(
        (change) => new ForgeExplorerItem(change.id, 'change', undefined, 'file', 'change')
      );
    }

    return [
      new ForgeExplorerItem(
        result.kind === 'invalid' ? 'Changes invalid' : 'Changes unavailable',
        result.kind === 'invalid' ? 'changes-invalid' : 'changes-unavailable',
        result.message,
        'warning'
      ),
    ];
  }

  private async discoverFor(folderUri: vscode.Uri): Promise<ForgeChangeDiscoveryResult> {
    const key = folderUri.toString();
    const cached = this.discoveryResults.get(key);
    if (cached) {
      return cached;
    }

    const folder = this.snapshot.kind === 'workspace'
      ? this.snapshot.folders.find(({ folder }) => folder.uri.toString() === key)?.folder
      : undefined;
    if (!folder) {
      return { kind: 'unavailable', message: 'Change discovery is unavailable.' };
    }

    const result = await this.discovery.discover(folder);
    this.discoveryResults.set(key, result);
    return result;
  }

  private async refreshProjection(snapshot: ForgeWorkspaceSnapshot): Promise<void> {
    this.snapshot = snapshot;
    const enabledKeys = new Set(
      snapshot.kind === 'workspace'
        ? snapshot.folders
            .filter(({ state }) => state.kind === 'forge-enabled')
            .map(({ folder }) => folder.uri.toString())
        : []
    );
    for (const key of this.discoveryResults.keys()) {
      if (!enabledKeys.has(key)) {
        this.discoveryResults.delete(key);
      }
    }

    if (snapshot.kind === 'workspace') {
      await Promise.all(
        snapshot.folders
          .filter(({ state }) => state.kind === 'forge-enabled')
          .map(({ folder }) => this.discoverFor(folder.uri))
      );
    }
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  dispose(): void {
    this.snapshotSubscription.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }
}