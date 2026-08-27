import * as vscode from 'vscode';

/**
 * `.forge/forge.yml` is workspace configuration, not Core Protocol semantics:
 * forge-protocol's own `protocol/README.md` states "`protocol/` defines
 * Forge. `.forge/` configures Forge for a repository." Its role as the
 * initialization marker comes from the current Forge CLI's `.forge/`
 * layout — `forge init` stages this file together with the rest of
 * `.forge/` and publishes it via a single atomic rename
 * (`forge_cli.workspace.initialize_workspace`), so its presence is
 * meaningfully stronger evidence than `.forge/` alone existing. That is a
 * fact about the current CLI implementation and workspace layout, not a
 * Protocol invariant this extension is entitled to assume permanent.
 * Detection here relies on that practical contract without elevating it
 * to Protocol semantics, and does not parse or schema-validate the file
 * (`forge/project@1`, `protocol/schemas/project.schema.json`), which
 * remains the CLI's responsibility.
 */
const PROJECT_MARKER_SEGMENTS = ['.forge', 'forge.yml'] as const;

/**
 * A closed, sanitized vocabulary for why detection could not reach a
 * conclusion — enough for diagnostics without forwarding raw error
 * messages or paths from arbitrary FileSystemProviders.
 */
export type ForgeDetectionFailureReason = 'no-permissions' | 'filesystem-unavailable' | 'unexpected-error';

export type ForgeDetectionState =
  | { readonly kind: 'forge-enabled' }
  | { readonly kind: 'not-forge' }
  | { readonly kind: 'unknown'; readonly reason: ForgeDetectionFailureReason };

const FORGE_ENABLED: ForgeDetectionState = { kind: 'forge-enabled' };
const NOT_FORGE: ForgeDetectionState = { kind: 'not-forge' };

function unknown(reason: ForgeDetectionFailureReason): ForgeDetectionState {
  return { kind: 'unknown', reason };
}

function classifyMarkerAccessError(error: unknown): ForgeDetectionState {
  if (error instanceof vscode.FileSystemError) {
    switch (error.code) {
      case 'FileNotFound':
      case 'FileNotADirectory':
        // A structurally proven absence: no file can exist at this path.
        return NOT_FORGE;
      case 'NoPermissions':
        return unknown('no-permissions');
      case 'Unavailable':
        return unknown('filesystem-unavailable');
      default:
        return unknown('unexpected-error');
    }
  }
  return unknown('unexpected-error');
}

export async function detectForgeWorkspaceFolderState(
  folder: vscode.WorkspaceFolder
): Promise<ForgeDetectionState> {
  const markerUri = vscode.Uri.joinPath(folder.uri, ...PROJECT_MARKER_SEGMENTS);

  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(markerUri);
  } catch (error) {
    return classifyMarkerAccessError(error);
  }

  // The marker path resolved to something other than a regular file (e.g.
  // a directory) — that is structurally proven, not indeterminate.
  return (stat.type & vscode.FileType.File) !== 0 ? FORGE_ENABLED : NOT_FORGE;
}

export interface ForgeWorkspaceFolderStatus {
  readonly folder: vscode.WorkspaceFolder;
  readonly state: ForgeDetectionState;
}

export type ForgeWorkspaceSnapshot =
  | { readonly kind: 'no-workspace' }
  | { readonly kind: 'workspace'; readonly folders: readonly ForgeWorkspaceFolderStatus[] };

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
                  state: await detectForgeWorkspaceFolderState(folder),
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
