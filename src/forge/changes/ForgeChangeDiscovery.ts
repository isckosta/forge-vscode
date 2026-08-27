import * as vscode from 'vscode';
import * as YAML from 'yaml';

export interface ForgeChangeDiscoveryFileSystem {
  stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
  readDirectory(uri: vscode.Uri): Thenable<readonly [string, vscode.FileType][]>;
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
}

export interface ForgeChange {
  readonly id: string;
  readonly manifestUri: vscode.Uri;
}

export type ForgeChangeDiscoveryResult =
  | { readonly kind: 'success'; readonly changes: readonly ForgeChange[] }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

const INVALID_MESSAGE = 'Change manifest is invalid.';
const UNAVAILABLE_MESSAGE = 'Change discovery is unavailable.';
const SUPPORTED_SCHEMAS = new Set(['forge/change@1', 'forge/change@2']);
const CHANGE_ID_PATTERN = /^CHG-[0-9]{4,}$/;

const defaultFileSystem: ForgeChangeDiscoveryFileSystem = {
  stat: (uri) => vscode.workspace.fs.stat(uri),
  readDirectory: (uri) => vscode.workspace.fs.readDirectory(uri),
  readFile: (uri) => vscode.workspace.fs.readFile(uri),
};

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof vscode.FileSystemError && error.code === code;
}

function isValidManifest(value: unknown): value is { schema: string; change: { id: string } } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const manifest = value as { schema?: unknown; change?: unknown };
  if (typeof manifest.schema !== 'string' || !SUPPORTED_SCHEMAS.has(manifest.schema)) {
    return false;
  }
  if (typeof manifest.change !== 'object' || manifest.change === null) {
    return false;
  }

  const change = manifest.change as { id?: unknown };
  return typeof change.id === 'string' && CHANGE_ID_PATTERN.test(change.id);
}

export class ForgeChangeDiscovery {
  constructor(private readonly fileSystem: ForgeChangeDiscoveryFileSystem = defaultFileSystem) {}

  async discover(folder: vscode.WorkspaceFolder): Promise<ForgeChangeDiscoveryResult> {
    const changesUri = vscode.Uri.joinPath(folder.uri, '.forge', 'changes');
    let changesStat: vscode.FileStat;
    try {
      changesStat = await this.fileSystem.stat(changesUri);
    } catch (error) {
      if (isFileSystemError(error, 'FileNotFound')) {
        return { kind: 'success', changes: [] };
      }
      return { kind: 'unavailable', message: UNAVAILABLE_MESSAGE };
    }

    if ((changesStat.type & vscode.FileType.Directory) === 0) {
      return { kind: 'unavailable', message: UNAVAILABLE_MESSAGE };
    }

    let entries: readonly [string, vscode.FileType][];
    try {
      entries = await this.fileSystem.readDirectory(changesUri);
    } catch {
      return { kind: 'unavailable', message: UNAVAILABLE_MESSAGE };
    }

    const changes: ForgeChange[] = [];
    for (const [directoryName, type] of entries) {
      if ((type & vscode.FileType.Directory) === 0) {
        continue;
      }

      const manifestUri = vscode.Uri.joinPath(changesUri, directoryName, 'manifest.yml');
      let contents: Uint8Array;
      try {
        contents = await this.fileSystem.readFile(manifestUri);
      } catch {
        return { kind: 'unavailable', message: UNAVAILABLE_MESSAGE };
      }

      let manifest: unknown;
      try {
        manifest = YAML.parse(new TextDecoder().decode(contents));
      } catch {
        return { kind: 'invalid', message: INVALID_MESSAGE };
      }

      if (!isValidManifest(manifest)) {
        return { kind: 'invalid', message: INVALID_MESSAGE };
      }

      changes.push({ id: manifest.change.id, manifestUri });
    }

    return { kind: 'success', changes };
  }
}