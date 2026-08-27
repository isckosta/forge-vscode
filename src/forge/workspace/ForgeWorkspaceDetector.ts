import * as vscode from 'vscode';

/**
 * Canonical Forge project marker (`forge init`, forge-protocol `src/forge_cli/app.py`).
 * `.forge/` and `forge.yml` are staged together and published via a single
 * atomic rename (`forge_cli.workspace.initialize_workspace`), so this file's
 * presence — not merely `.forge/` existing — is the repository-native
 * evidence of an initialized Forge project (`forge/project@1`,
 * `protocol/schemas/project.schema.json`). Detection here intentionally
 * stops at that evidence and does not parse or validate the file's schema,
 * which belongs to the Forge CLI.
 */
const PROJECT_MARKER_SEGMENTS = ['.forge', 'forge.yml'] as const;

export interface ForgeWorkspaceFolderStatus {
  readonly folder: vscode.WorkspaceFolder;
  readonly isForgeEnabled: boolean;
}

export type ForgeWorkspaceSnapshot =
  | { readonly kind: 'no-workspace' }
  | { readonly kind: 'workspace'; readonly folders: readonly ForgeWorkspaceFolderStatus[] };

export async function isForgeWorkspaceFolder(folder: vscode.WorkspaceFolder): Promise<boolean> {
  const markerUri = vscode.Uri.joinPath(folder.uri, ...PROJECT_MARKER_SEGMENTS);

  try {
    const stat = await vscode.workspace.fs.stat(markerUri);
    return (stat.type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

interface ForgeWorkspaceDetectorDependencies {
  getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  onDidChangeWorkspaceFolders: vscode.Event<unknown>;
}

const defaultDependencies: ForgeWorkspaceDetectorDependencies = {
  getWorkspaceFolders: () => vscode.workspace.workspaceFolders,
  onDidChangeWorkspaceFolders: vscode.workspace.onDidChangeWorkspaceFolders,
};

export class ForgeWorkspaceDetector implements vscode.Disposable {
  private readonly deps: ForgeWorkspaceDetectorDependencies;
  private readonly onDidChangeSnapshotEmitter = new vscode.EventEmitter<ForgeWorkspaceSnapshot>();
  private readonly subscription: vscode.Disposable;
  private snapshot: ForgeWorkspaceSnapshot = { kind: 'no-workspace' };

  readonly onDidChangeSnapshot = this.onDidChangeSnapshotEmitter.event;

  constructor(dependencies: Partial<ForgeWorkspaceDetectorDependencies> = {}) {
    this.deps = { ...defaultDependencies, ...dependencies };
    this.subscription = this.deps.onDidChangeWorkspaceFolders(() => {
      void this.refresh();
    });
  }

  getSnapshot(): ForgeWorkspaceSnapshot {
    return this.snapshot;
  }

  async refresh(): Promise<ForgeWorkspaceSnapshot> {
    const folders = this.deps.getWorkspaceFolders();

    this.snapshot =
      !folders || folders.length === 0
        ? { kind: 'no-workspace' }
        : {
            kind: 'workspace',
            folders: await Promise.all(
              folders.map(
                async (folder): Promise<ForgeWorkspaceFolderStatus> => ({
                  folder,
                  isForgeEnabled: await isForgeWorkspaceFolder(folder),
                })
              )
            ),
          };

    this.onDidChangeSnapshotEmitter.fire(this.snapshot);
    return this.snapshot;
  }

  dispose(): void {
    this.subscription.dispose();
    this.onDidChangeSnapshotEmitter.dispose();
  }
}
