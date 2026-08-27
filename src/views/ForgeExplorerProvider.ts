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

export interface ForgeFileSystemWatcherFactory {
  createFileSystemWatcher(pattern: vscode.GlobPattern): vscode.FileSystemWatcher;
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
  private readonly watcherFactory: ForgeFileSystemWatcherFactory;
  private readonly discoveryResults = new Map<string, ForgeChangeDiscoveryResult>();
  private readonly discoveryVersions = new Map<string, number>();
  private readonly workspaceItems = new Map<string, ForgeExplorerItem>();
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly filesystemRefreshes = new Set<string>();
  private readonly dirtyFilesystemRefreshes = new Set<string>();
  private snapshot: ForgeWorkspaceSnapshot;
  private snapshotGeneration = 0;
  private disposed = false;

  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(
    source: ForgeWorkspaceSnapshotSource,
    discovery: ForgeChangeDiscoverySource = new ForgeChangeDiscovery(),
    watcherFactory: ForgeFileSystemWatcherFactory = vscode.workspace
  ) {
    this.discovery = discovery;
    this.watcherFactory = watcherFactory;
    this.snapshot = source.getSnapshot();
    this.reconcileWatchers(this.snapshot);
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
          return this.getWorkspaceItem(folder.uri)!;
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
    if (!this.getEnabledFolder(folderUri)) {
      return [];
    }
    const generation = this.snapshotGeneration;
    await this.discoverFor(folderUri);
    if (generation !== this.snapshotGeneration || !this.getEnabledFolder(folderUri)) {
      return [];
    }
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
    if (!this.getEnabledFolder(folderUri)) {
      return [];
    }
    const generation = this.snapshotGeneration;
    const result = await this.discoverFor(folderUri);
    if (generation !== this.snapshotGeneration || !this.getEnabledFolder(folderUri)) {
      return [];
    }
    if (result.kind === 'success') {
      if (result.changes.length === 0) {
        return [new ForgeExplorerItem('No Changes found', 'changes-empty', undefined, 'info')];
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
    const folder = this.getEnabledFolder(folderUri);
    if (!folder) {
      return { kind: 'unavailable', message: 'Change discovery is unavailable.' };
    }

    const cached = this.discoveryResults.get(key);
    if (cached) {
      return cached;
    }

    const generation = this.snapshotGeneration;
    const version = this.discoveryVersions.get(key) ?? 0;
    const result = await this.discovery.discover(folder);
    if (
      !this.disposed &&
      generation === this.snapshotGeneration &&
      version === (this.discoveryVersions.get(key) ?? 0) &&
      this.getEnabledFolder(folderUri)
    ) {
      this.discoveryResults.set(key, result);
    }
    return result;
  }

  private getEnabledFolder(folderUri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    if (this.snapshot.kind !== 'workspace') {
      return undefined;
    }

    return this.snapshot.folders.find(
      ({ folder, state }) => folder.uri.toString() === folderUri.toString() && state.kind === 'forge-enabled'
    )?.folder;
  }

  private async refreshProjection(snapshot: ForgeWorkspaceSnapshot): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.snapshotGeneration += 1;
    this.snapshot = snapshot;
    this.reconcileWatchers(snapshot);
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
    for (const key of this.workspaceItems.keys()) {
      if (!enabledKeys.has(key)) {
        this.workspaceItems.delete(key);
      }
    }

    if (snapshot.kind === 'workspace') {
      await Promise.all(
        snapshot.folders
          .filter(({ state }) => state.kind === 'forge-enabled')
          .map(({ folder }) => this.discoverFor(folder.uri))
      );
    }
    if (!this.disposed) {
      this.onDidChangeTreeDataEmitter.fire(undefined);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.snapshotSubscription.dispose();
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  private reconcileWatchers(snapshot: ForgeWorkspaceSnapshot): void {
    const enabledFolders =
      snapshot.kind === 'workspace'
        ? snapshot.folders.filter(({ state }) => state.kind === 'forge-enabled')
        : [];
    const enabledKeys = new Set(enabledFolders.map(({ folder }) => folder.uri.toString()));

    for (const [key, watcher] of this.watchers) {
      if (!enabledKeys.has(key)) {
        watcher.dispose();
        this.watchers.delete(key);
      }
    }

    for (const { folder } of enabledFolders) {
      const key = folder.uri.toString();
      if (this.watchers.has(key)) {
        continue;
      }

      const pattern = new vscode.RelativePattern(folder.uri, '.forge/changes/**');
      const watcher = this.watcherFactory.createFileSystemWatcher(pattern);
      const subscriptions = [
        watcher.onDidCreate(() => void this.refreshFromFilesystem(folder.uri)),
        watcher.onDidChange(() => void this.refreshFromFilesystem(folder.uri)),
        watcher.onDidDelete(() => void this.refreshFromFilesystem(folder.uri)),
      ];
      this.watchers.set(
        key,
        new vscode.Disposable(() => {
          for (const subscription of subscriptions) {
            subscription.dispose();
          }
          watcher.dispose();
        })
      );
    }
  }

  private async refreshFromFilesystem(folderUri: vscode.Uri): Promise<void> {
    if (this.disposed || !this.getEnabledFolder(folderUri)) {
      return;
    }

    const key = folderUri.toString();
    if (this.filesystemRefreshes.has(key)) {
      this.dirtyFilesystemRefreshes.add(key);
      return;
    }
    this.filesystemRefreshes.add(key);
    try {
      do {
        const hadPendingFilesystemRefresh = this.dirtyFilesystemRefreshes.delete(key);
        const generation = this.snapshotGeneration;
        this.discoveryVersions.set(key, (this.discoveryVersions.get(key) ?? 0) + 1);
        this.discoveryResults.delete(key);
        await this.discoverFor(folderUri);
        if (this.disposed || !this.getEnabledFolder(folderUri)) {
          break;
        }

        if (generation !== this.snapshotGeneration) {
          if (hadPendingFilesystemRefresh || this.dirtyFilesystemRefreshes.has(key)) {
            this.dirtyFilesystemRefreshes.add(key);
          } else {
            break;
          }
        }

        if (!this.dirtyFilesystemRefreshes.has(key)) {
          const workspaceItem = this.getWorkspaceItem(folderUri);
          if (workspaceItem) {
            this.onDidChangeTreeDataEmitter.fire(workspaceItem);
          }
        }
      } while (this.dirtyFilesystemRefreshes.has(key));
    } finally {
      this.filesystemRefreshes.delete(key);
      this.dirtyFilesystemRefreshes.delete(key);
    }
  }

  private getWorkspaceItem(folderUri: vscode.Uri): ForgeExplorerItem | undefined {
    const folder = this.getEnabledFolder(folderUri);
    if (!folder) {
      return undefined;
    }

    const key = folderUri.toString();
    const cached = this.workspaceItems.get(key);
    if (cached) {
      return cached;
    }

    const item = new ForgeExplorerItem(
      folder.name,
      'forge-enabled',
      'Forge enabled',
      'pass',
      'workspace',
      folder.uri,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    this.workspaceItems.set(key, item);
    return item;
  }
}