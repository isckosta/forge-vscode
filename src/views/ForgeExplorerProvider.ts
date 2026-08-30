import * as vscode from 'vscode';
import {
  ForgeDetectionFailureReason,
  ForgeWorkspaceSnapshot,
} from '../forge/workspace/ForgeWorkspaceDetector';
import {
  ForgeChangeDiscovery,
  ForgeChangeDiscoveryResult,
} from '../forge/changes/ForgeChangeDiscovery';
import {
  ForgeReview,
  ForgeReviewFinding,
  ForgeReviewMode,
  ForgeReviewReader,
  ForgeReviewResult,
  ForgeReviewStage,
} from '../forge/review/ForgeReviewReader';

export interface ForgeWorkspaceSnapshotSource {
  readonly onDidChangeSnapshot: vscode.Event<ForgeWorkspaceSnapshot>;
  getSnapshot(): ForgeWorkspaceSnapshot;
}

export interface ForgeChangeDiscoverySource {
  discover(folder: vscode.WorkspaceFolder): Promise<ForgeChangeDiscoveryResult>;
}

export interface ForgeReviewSource {
  discover(folder: vscode.WorkspaceFolder, changeId: string): Promise<ForgeReviewResult>;
}

export interface ForgeFileSystemWatcherFactory {
  createFileSystemWatcher(pattern: vscode.GlobPattern): vscode.FileSystemWatcher;
}

type ForgeExplorerItemKind = 'workspace' | 'changes' | 'change' | 'review-findings' | 'state' | 'status';

export type ForgeExplorerItemContextValue =
  | 'forge-enabled'
  | 'not-forge'
  | 'unknown'
  | 'no-workspace'
  | 'changes'
  | 'change'
  | 'changes-empty'
  | 'changes-unavailable'
  | 'changes-invalid'
  | 'review-mode'
  | 'review-stage'
  | 'review-findings'
  | 'review-next'
  | 'review-result'
  | 'review-not-started'
  | 'review-unavailable'
  | 'review-invalid'
  | 'finding-open'
  | 'finding-resolved';

export class ForgeExplorerItem extends vscode.TreeItem {
  readonly kind: ForgeExplorerItemKind;
  readonly folderUri?: vscode.Uri;
  readonly changeId?: string;

  constructor(
    label: string,
    contextValue: ForgeExplorerItemContextValue,
    description?: string,
    iconId?: string,
    kind: ForgeExplorerItemKind = 'status',
    folderUri?: vscode.Uri,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    changeId?: string
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    this.description = description;
    this.iconPath = iconId ? new vscode.ThemeIcon(iconId) : undefined;
    this.kind = kind;
    this.folderUri = folderUri;
    this.changeId = changeId;
  }
}

const REVIEW_MODE_LABELS: Readonly<Record<ForgeReviewMode, string>> = {
  recommended: 'Recommended',
  fast: 'Fast',
  thorough: 'Thorough',
};

const REVIEW_STAGE_LABELS: Readonly<Record<ForgeReviewStage, string>> = {
  discovery: 'Discovery',
  findings: 'Findings',
  resolution: 'Resolution',
  're-review': 'Re-review',
  concluded: 'Concluded',
};

function buildFindingItem(finding: ForgeReviewFinding): ForgeExplorerItem {
  const icon = finding.status === 'resolved' ? 'pass' : finding.blocking ? 'error' : 'warning';
  const descriptionParts = [finding.blocking && finding.status === 'open' ? 'blocking' : undefined, finding.summary].filter(
    (part): part is string => Boolean(part)
  );
  const item = new ForgeExplorerItem(
    finding.id,
    finding.status === 'resolved' ? 'finding-resolved' : 'finding-open',
    descriptionParts.join(' · '),
    icon
  );
  if (finding.evidenceUri) {
    item.command = {
      command: 'vscode.open',
      title: 'Open Evidence',
      arguments: [finding.evidenceUri],
    };
  }
  return item;
}

function buildReviewItems(review: ForgeReview, folderUri: vscode.Uri, changeId: string): ForgeExplorerItem[] {
  const items: ForgeExplorerItem[] = [];

  const effectiveDescription = review.effectiveProfileReason
    ? `Effective: ${review.effectiveProfile} (${review.effectiveProfileReason})`
    : `Effective: ${review.effectiveProfile}`;
  items.push(
    new ForgeExplorerItem(`Mode: ${REVIEW_MODE_LABELS[review.mode]}`, 'review-mode', effectiveDescription, 'settings-gear')
  );

  items.push(
    new ForgeExplorerItem(`Stage: ${REVIEW_STAGE_LABELS[review.stage]}`, 'review-stage', review.summary, 'sync')
  );

  if (review.findings.length > 0) {
    const resolved = review.findings.filter((finding) => finding.status === 'resolved').length;
    items.push(
      new ForgeExplorerItem(
        `Findings (${resolved}/${review.findings.length} resolved)`,
        'review-findings',
        undefined,
        'list-unordered',
        'review-findings',
        folderUri,
        vscode.TreeItemCollapsibleState.Collapsed,
        changeId
      )
    );
  }

  if (review.stage !== 'concluded' && review.remaining) {
    items.push(new ForgeExplorerItem(`Next: ${review.remaining}`, 'review-next', undefined, 'arrow-right'));
  }

  if (review.concluded) {
    const { concluded } = review;
    const resultLabels: Record<typeof concluded.result, string> = {
      clear: 'Result: Clear',
      'stopped-with-open-findings': 'Result: Stopped with open findings',
      stopped: 'Result: Stopped',
    };
    const description = `${concluded.openFindingsCount} open finding${concluded.openFindingsCount === 1 ? '' : 's'}${
      concluded.canClaimSuccess ? '' : ' · not a pass'
    }`;
    items.push(
      new ForgeExplorerItem(
        resultLabels[concluded.result],
        'review-result',
        description,
        concluded.result === 'clear' ? 'pass' : 'warning'
      )
    );
  }

  return items;
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
  private readonly reviewReader: ForgeReviewSource;
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
    watcherFactory: ForgeFileSystemWatcherFactory = vscode.workspace,
    reviewReader: ForgeReviewSource = new ForgeReviewReader()
  ) {
    this.discovery = discovery;
    this.watcherFactory = watcherFactory;
    this.reviewReader = reviewReader;
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
      if (element.kind === 'change' && element.folderUri && element.changeId) {
        return this.getReviewItems(element.folderUri, element.changeId);
      }
      if (element.kind === 'review-findings' && element.folderUri && element.changeId) {
        return this.getFindingItems(element.folderUri, element.changeId);
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
        (change) =>
          new ForgeExplorerItem(
            change.id,
            'change',
            undefined,
            'file',
            'change',
            folderUri,
            vscode.TreeItemCollapsibleState.Collapsed,
            change.id
          )
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

  private async getReviewItems(folderUri: vscode.Uri, changeId: string): Promise<ForgeExplorerItem[]> {
    const folder = this.getEnabledFolder(folderUri);
    if (!folder) {
      return [];
    }
    const generation = this.snapshotGeneration;
    const result = await this.reviewReader.discover(folder, changeId);
    if (generation !== this.snapshotGeneration || !this.getEnabledFolder(folderUri)) {
      return [];
    }

    switch (result.kind) {
      case 'success':
        return buildReviewItems(result.review, folderUri, changeId);
      case 'not-started':
        return [
          new ForgeExplorerItem(
            'Review not started',
            'review-not-started',
            'Recommended mode runs by default',
            'circle-outline'
          ),
        ];
      case 'unavailable':
      case 'invalid':
        return [
          new ForgeExplorerItem(
            result.kind === 'invalid' ? 'Review invalid' : 'Review unavailable',
            result.kind === 'invalid' ? 'review-invalid' : 'review-unavailable',
            result.message,
            'warning'
          ),
        ];
    }
  }

  private async getFindingItems(folderUri: vscode.Uri, changeId: string): Promise<ForgeExplorerItem[]> {
    const folder = this.getEnabledFolder(folderUri);
    if (!folder) {
      return [];
    }
    const generation = this.snapshotGeneration;
    const result = await this.reviewReader.discover(folder, changeId);
    if (generation !== this.snapshotGeneration || !this.getEnabledFolder(folderUri) || result.kind !== 'success') {
      return [];
    }

    return result.review.findings.map((finding) => buildFindingItem(finding));
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
        this.dirtyFilesystemRefreshes.delete(key);
        const generation = this.snapshotGeneration;
        this.discoveryVersions.set(key, (this.discoveryVersions.get(key) ?? 0) + 1);
        this.discoveryResults.delete(key);
        await this.discoverFor(folderUri);
        if (this.disposed || !this.getEnabledFolder(folderUri)) {
          break;
        }

        if (generation !== this.snapshotGeneration) {
          this.dirtyFilesystemRefreshes.add(key);
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