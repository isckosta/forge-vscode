import * as vscode from 'vscode';
import { registerShowVersionCommand } from './commands/showVersion';
import { ForgeWorkspaceDetector } from './forge/workspace/ForgeWorkspaceDetector';
import { ForgeExplorerProvider } from './views/ForgeExplorerProvider';

export function activate(context: vscode.ExtensionContext): void {
  registerShowVersionCommand(context);

  const forgeWorkspaceDetector = new ForgeWorkspaceDetector();
  const forgeExplorerProvider = new ForgeExplorerProvider(forgeWorkspaceDetector);
  context.subscriptions.push(forgeWorkspaceDetector);
  context.subscriptions.push(forgeExplorerProvider);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('forge.explorer', forgeExplorerProvider)
  );
  void forgeWorkspaceDetector.refresh();
}

export function deactivate(): void {
  // No cleanup required.
}
