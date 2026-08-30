import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ForgeReviewMessages,
  ForgeReviewModeConfig,
  ForgeReviewModePicker,
  ReviewStateSource,
  setDefaultReviewMode,
  setReviewMode,
  stopReview,
} from '../commands/reviewCommands';
import { ForgeExplorerItem } from '../views/ForgeExplorerProvider';
import { ForgeCliClient, ForgeCliProcessResult, ForgeCliRunner } from '../forge/cli/ForgeCliClient';
import { ForgeReviewMode, ForgeReviewResult } from '../forge/review/ForgeReviewReader';

class RecordingRunner implements ForgeCliRunner {
  public calls: Array<{ args: readonly string[]; cwd: string }> = [];

  constructor(private readonly result: ForgeCliProcessResult = { stdout: '', stderr: '', exitCode: 0 }) {}

  async run(args: readonly string[], cwd: string): Promise<ForgeCliProcessResult> {
    this.calls.push({ args, cwd });
    return this.result;
  }
}

class RecordingMessages implements ForgeReviewMessages {
  errors: string[] = [];
  infos: string[] = [];
  confirmDetails: string[] = [];

  constructor(private readonly confirmResult = true) {}

  showError(message: string): void {
    this.errors.push(message);
  }
  showInfo(message: string): void {
    this.infos.push(message);
  }
  async confirmStop(detail: string): Promise<boolean> {
    this.confirmDetails.push(detail);
    return this.confirmResult;
  }
}

function changeItem(changeId = 'CHG-0001'): ForgeExplorerItem {
  return new ForgeExplorerItem(
    changeId,
    'change',
    undefined,
    'file',
    'change',
    vscode.Uri.file('/workspace'),
    vscode.TreeItemCollapsibleState.Collapsed,
    changeId
  );
}

function picker(mode: ForgeReviewMode | undefined): ForgeReviewModePicker {
  return { pick: async () => mode };
}

function config(defaultMode: ForgeReviewMode = 'recommended'): ForgeReviewModeConfig & {
  updates: Array<{ folderUri: vscode.Uri | undefined; mode: ForgeReviewMode }>;
} {
  const updates: Array<{ folderUri: vscode.Uri | undefined; mode: ForgeReviewMode }> = [];
  return {
    updates,
    getDefaultMode: () => defaultMode,
    setDefaultMode: async (folderUri, mode) => {
      updates.push({ folderUri, mode });
    },
  };
}

suite('reviewCommands', () => {
  test('setReviewMode shows an error and skips the CLI when no Change is selected', async () => {
    const runner = new RecordingRunner();
    const messages = new RecordingMessages();
    await setReviewMode(undefined, {
      cli: new ForgeCliClient(runner),
      picker: picker('fast'),
      messages,
      config: config(),
    });

    assert.deepStrictEqual(runner.calls, []);
    assert.deepStrictEqual(messages.errors, ['Select a Change in the Forge Explorer first.']);
  });

  test('setReviewMode does nothing when the picker is cancelled', async () => {
    const runner = new RecordingRunner();
    const messages = new RecordingMessages();
    await setReviewMode(changeItem(), {
      cli: new ForgeCliClient(runner),
      picker: picker(undefined),
      messages,
      config: config(),
    });

    assert.deepStrictEqual(runner.calls, []);
    assert.deepStrictEqual(messages.errors, []);
  });

  test('setReviewMode invokes the Forge CLI with the picked mode', async () => {
    const runner = new RecordingRunner();
    const messages = new RecordingMessages();
    await setReviewMode(changeItem('CHG-0042'), {
      cli: new ForgeCliClient(runner),
      picker: picker('thorough'),
      messages,
      config: config(),
    });

    assert.strictEqual(runner.calls.length, 1);
    assert.deepStrictEqual(runner.calls[0]?.args, ['review', 'set-mode', 'CHG-0042', 'thorough']);
    assert.strictEqual(runner.calls[0]?.cwd, vscode.Uri.file('/workspace').fsPath);
    assert.deepStrictEqual(messages.errors, []);
  });

  test('setReviewMode surfaces a CLI failure without claiming success', async () => {
    const runner = new RecordingRunner({ stdout: '', stderr: 'Change not found', exitCode: 1 });
    const messages = new RecordingMessages();
    await setReviewMode(changeItem(), {
      cli: new ForgeCliClient(runner),
      picker: picker('fast'),
      messages,
      config: config(),
    });

    assert.deepStrictEqual(messages.errors, ['Forge CLI failed: Change not found']);
  });

  test('setDefaultReviewMode persists the picked mode as the preference', async () => {
    const cfg = config('recommended');
    await setDefaultReviewMode(changeItem(), { picker: picker('fast'), config: cfg });

    assert.strictEqual(cfg.updates.length, 1);
    assert.strictEqual(cfg.updates[0]?.mode, 'fast');
  });

  test('setDefaultReviewMode does nothing when the picker is cancelled', async () => {
    const cfg = config();
    await setDefaultReviewMode(undefined, { picker: picker(undefined), config: cfg });

    assert.deepStrictEqual(cfg.updates, []);
  });

  test('stopReview shows an error when no Change is selected', async () => {
    const messages = new RecordingMessages();
    const reviewReader: ReviewStateSource = { discover: async () => ({ kind: 'not-started' }) };
    await stopReview(undefined, { cli: new ForgeCliClient(new RecordingRunner()), reviewReader, messages });

    assert.deepStrictEqual(messages.errors, ['Select a Change in the Forge Explorer first.']);
  });

  test('stopReview reports there is nothing to stop when the review has not started', async () => {
    const runner = new RecordingRunner();
    const messages = new RecordingMessages();
    const reviewReader: ReviewStateSource = { discover: async () => ({ kind: 'not-started' }) };
    await stopReview(changeItem(), { cli: new ForgeCliClient(runner), reviewReader, messages });

    assert.deepStrictEqual(runner.calls, []);
    assert.deepStrictEqual(messages.infos, ['No active review to stop.']);
  });

  test('stopReview reports an already-concluded review without re-invoking the CLI', async () => {
    const runner = new RecordingRunner();
    const messages = new RecordingMessages();
    const result: ForgeReviewResult = {
      kind: 'success',
      review: {
        mode: 'recommended',
        effectiveProfile: 'standard',
        stage: 'concluded',
        findings: [],
        concluded: { result: 'clear', openFindingsCount: 0, canClaimSuccess: true },
      },
    };
    const reviewReader: ReviewStateSource = { discover: async () => result };
    await stopReview(changeItem(), { cli: new ForgeCliClient(runner), reviewReader, messages });

    assert.deepStrictEqual(runner.calls, []);
    assert.deepStrictEqual(messages.infos, ['Review has already concluded.']);
  });

  test('stopReview warns about unresolved blocking findings before stopping and never claims success', async () => {
    const runner = new RecordingRunner();
    const messages = new RecordingMessages(true);
    const result: ForgeReviewResult = {
      kind: 'success',
      review: {
        mode: 'thorough',
        effectiveProfile: 'strict',
        stage: 'resolution',
        findings: [
          { id: 'F-001', status: 'open', blocking: true, summary: 'Missing auth check' },
          { id: 'F-002', status: 'resolved', blocking: false, summary: 'Unused import' },
        ],
      },
    };
    const reviewReader: ReviewStateSource = { discover: async () => result };
    await stopReview(changeItem('CHG-0007'), { cli: new ForgeCliClient(runner), reviewReader, messages });

    assert.strictEqual(messages.confirmDetails.length, 1);
    assert.match(messages.confirmDetails[0]!, /1 finding\(s\) remain unresolved \(1 blocking\)/);
    assert.match(messages.confirmDetails[0]!, /never be shown as passed/);
    assert.deepStrictEqual(runner.calls[0]?.args, ['review', 'stop', 'CHG-0007']);
  });

  test('stopReview does not call the CLI when the developer declines to confirm', async () => {
    const runner = new RecordingRunner();
    const messages = new RecordingMessages(false);
    const result: ForgeReviewResult = {
      kind: 'success',
      review: {
        mode: 'recommended',
        effectiveProfile: 'standard',
        stage: 'discovery',
        findings: [],
      },
    };
    const reviewReader: ReviewStateSource = { discover: async () => result };
    await stopReview(changeItem(), { cli: new ForgeCliClient(runner), reviewReader, messages });

    assert.deepStrictEqual(runner.calls, []);
  });

  test('stopReview surfaces unavailable and invalid review states as errors', async () => {
    for (const kind of ['unavailable', 'invalid'] as const) {
      const runner = new RecordingRunner();
      const messages = new RecordingMessages();
      const reviewReader: ReviewStateSource = {
        discover: async () => ({ kind, message: `Review state is ${kind}.` }),
      };
      await stopReview(changeItem(), { cli: new ForgeCliClient(runner), reviewReader, messages });

      assert.deepStrictEqual(runner.calls, []);
      assert.deepStrictEqual(messages.errors, [`Review state is ${kind}.`]);
    }
  });
});
