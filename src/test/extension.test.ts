import * as assert from 'assert';
import * as vscode from 'vscode';
import { getVersionMessage } from '../commands/showVersion';

suite('Forge for VS Code', () => {
  test('activates and registers the forge.showVersion command', async () => {
    const extension = vscode.extensions.getExtension('forge-protocol.forge-vscode');
    assert.ok(extension, 'extension should be discoverable');

    await extension!.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('forge.showVersion'),
      'forge.showVersion should be registered'
    );
  });

  test('forge.showVersion executes without throwing', async () => {
    const extension = vscode.extensions.getExtension('forge-protocol.forge-vscode');
    await extension!.activate();

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('forge.showVersion');
    });
  });

  test('getVersionMessage formats the extension version', () => {
    assert.strictEqual(getVersionMessage('0.0.1'), 'Forge for VS Code v0.0.1');
  });
});
