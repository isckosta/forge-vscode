import * as vscode from 'vscode';
import { registerShowVersionCommand } from './commands/showVersion';

export function activate(context: vscode.ExtensionContext): void {
  registerShowVersionCommand(context);
}

export function deactivate(): void {
  // No cleanup required.
}
