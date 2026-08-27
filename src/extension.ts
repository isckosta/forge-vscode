import * as vscode from 'vscode';
import { registerShowVersionCommand } from './commands/showVersion';
import { ForgeWorkspaceDetector } from './forge/workspace/ForgeWorkspaceDetector';

export function activate(context: vscode.ExtensionContext): void {
  registerShowVersionCommand(context);

  const forgeWorkspaceDetector = new ForgeWorkspaceDetector();
  context.subscriptions.push(forgeWorkspaceDetector);
  void forgeWorkspaceDetector.refresh();
}

export function deactivate(): void {
  // No cleanup required.
}
