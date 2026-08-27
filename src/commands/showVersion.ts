import * as vscode from 'vscode';

export function getVersionMessage(version: string): string {
  return `Forge for VS Code v${version}`;
}

export function registerShowVersionCommand(context: vscode.ExtensionContext): void {
  const version = context.extension.packageJSON.version as string;

  const disposable = vscode.commands.registerCommand('forge.showVersion', () => {
    vscode.window.showInformationMessage(getVersionMessage(version));
  });

  context.subscriptions.push(disposable);
}
