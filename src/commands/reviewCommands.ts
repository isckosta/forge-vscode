import * as vscode from 'vscode';
import { ForgeExplorerItem } from '../views/ForgeExplorerProvider';
import { ForgeCliClient, ForgeCliResult } from '../forge/cli/ForgeCliClient';
import { ForgeReviewMode, ForgeReviewReader, ForgeReviewResult } from '../forge/review/ForgeReviewReader';

/**
 * Review mode selection and stopping are normative operations — they change
 * what Forge will do next — so, like other normative operations in this
 * extension, they are delegated to the Forge CLI rather than performed
 * in-process. See `ForgeCliClient` for the assumed CLI surface.
 *
 * Every dependency the real VS Code APIs would otherwise provide directly
 * (quick picks, confirmation dialogs, configuration) is injected here, in
 * the same style as `ForgeChangeDiscovery`/`ForgeReviewReader` inject a
 * filesystem, so the command logic — in particular the "never let a
 * developer silently claim success over open findings" confirmation below
 * — is unit-testable without a running Extension Host.
 */

export interface ReviewStateSource {
  discover(folder: vscode.WorkspaceFolder, changeId: string): Promise<ForgeReviewResult>;
}

export interface ForgeReviewModePicker {
  pick(defaultMode: ForgeReviewMode): Promise<ForgeReviewMode | undefined>;
}

export interface ForgeReviewMessages {
  showError(message: string): void;
  showInfo(message: string): void;
  confirmStop(detail: string): Promise<boolean>;
}

export interface ForgeReviewModeConfig {
  getDefaultMode(folderUri?: vscode.Uri): ForgeReviewMode;
  setDefaultMode(folderUri: vscode.Uri | undefined, mode: ForgeReviewMode): Promise<void>;
}

export interface ForgeReviewCommandDeps {
  readonly cli: ForgeCliClient;
  readonly reviewReader: ReviewStateSource;
  readonly picker: ForgeReviewModePicker;
  readonly messages: ForgeReviewMessages;
  readonly config: ForgeReviewModeConfig;
}

const NO_SELECTION_MESSAGE = 'Select a Change in the Forge Explorer first.';

function reportCliFailure(result: ForgeCliResult, messages: ForgeReviewMessages): void {
  if (result.kind === 'cli-not-found') {
    messages.showError('Forge CLI ("forge") was not found on PATH.');
  } else if (result.kind === 'execution-failed') {
    messages.showError(`Forge CLI failed: ${result.message}`);
  }
}

export async function setReviewMode(
  item: ForgeExplorerItem | undefined,
  deps: Pick<ForgeReviewCommandDeps, 'cli' | 'picker' | 'messages' | 'config'>
): Promise<void> {
  if (!item?.folderUri || !item.changeId) {
    deps.messages.showError(NO_SELECTION_MESSAGE);
    return;
  }

  const defaultMode = deps.config.getDefaultMode(item.folderUri);
  const mode = await deps.picker.pick(defaultMode);
  if (!mode) {
    return;
  }

  const result = await deps.cli.run(['review', 'set-mode', item.changeId, mode], item.folderUri.fsPath);
  reportCliFailure(result, deps.messages);
}

export async function setDefaultReviewMode(
  item: ForgeExplorerItem | undefined,
  deps: Pick<ForgeReviewCommandDeps, 'picker' | 'config'>
): Promise<void> {
  const folderUri = item?.folderUri;
  const currentDefault = deps.config.getDefaultMode(folderUri);
  const mode = await deps.picker.pick(currentDefault);
  if (!mode) {
    return;
  }

  await deps.config.setDefaultMode(folderUri, mode);
}

export async function stopReview(
  item: ForgeExplorerItem | undefined,
  deps: Pick<ForgeReviewCommandDeps, 'cli' | 'reviewReader' | 'messages'>
): Promise<void> {
  if (!item?.folderUri || !item.changeId) {
    deps.messages.showError(NO_SELECTION_MESSAGE);
    return;
  }

  const folder: vscode.WorkspaceFolder = { uri: item.folderUri, name: item.folderUri.toString(), index: 0 };
  const review = await deps.reviewReader.discover(folder, item.changeId);

  if (review.kind === 'not-started') {
    deps.messages.showInfo('No active review to stop.');
    return;
  }
  if (review.kind !== 'success') {
    deps.messages.showError(review.message);
    return;
  }
  if (review.review.stage === 'concluded') {
    deps.messages.showInfo('Review has already concluded.');
    return;
  }

  const openFindings = review.review.findings.filter((finding) => finding.status === 'open');
  const blockingCount = openFindings.filter((finding) => finding.blocking).length;
  const detail =
    openFindings.length === 0
      ? 'Forge has not concluded the review yet. Stopping now will not be recorded as a pass.'
      : `${openFindings.length} finding(s) remain unresolved (${blockingCount} blocking). Stopping now will record the review as stopped with open findings — it will never be shown as passed.`;

  const confirmed = await deps.messages.confirmStop(detail);
  if (!confirmed) {
    return;
  }

  const result = await deps.cli.run(['review', 'stop', item.changeId], item.folderUri.fsPath);
  reportCliFailure(result, deps.messages);
}

const MODE_OPTIONS: ReadonlyArray<{ mode: ForgeReviewMode; label: string; description: string }> = [
  {
    mode: 'recommended',
    label: 'Recommended',
    description: 'Default. Forge determines the rigor appropriate to the Change.',
  },
  { mode: 'fast', label: 'Fast', description: 'Prioritizes speed and the findings that matter most.' },
  {
    mode: 'thorough',
    label: 'Thorough',
    description: 'Deeper, adversarial analysis for changes that need stronger assurance.',
  },
];

const realPicker: ForgeReviewModePicker = {
  async pick(defaultMode) {
    const items = MODE_OPTIONS.map((option) => ({
      label: option.mode === defaultMode ? `$(check) ${option.label}` : option.label,
      description: option.description,
      mode: option.mode,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Forge: Review Mode',
      placeHolder: 'Select a Review mode for this Change',
    });
    return picked?.mode;
  },
};

const realMessages: ForgeReviewMessages = {
  showError: (message) => void vscode.window.showErrorMessage(message),
  showInfo: (message) => void vscode.window.showInformationMessage(message),
  async confirmStop(detail) {
    const choice = await vscode.window.showWarningMessage(
      'Stop this Review?',
      { modal: true, detail },
      'Stop Review'
    );
    return choice === 'Stop Review';
  },
};

const CONFIGURATION_SECTION = 'forge';
const DEFAULT_MODE_SETTING = 'review.defaultMode';

const realConfig: ForgeReviewModeConfig = {
  getDefaultMode(folderUri) {
    const value = vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION, folderUri)
      .get<string>(DEFAULT_MODE_SETTING);
    return value === 'fast' || value === 'thorough' ? value : 'recommended';
  },
  async setDefaultMode(folderUri, mode) {
    const target =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace
      .getConfiguration(CONFIGURATION_SECTION, folderUri)
      .update(DEFAULT_MODE_SETTING, mode, target);
  },
};

export function registerReviewCommands(
  context: vscode.ExtensionContext,
  reviewReader: ReviewStateSource = new ForgeReviewReader(),
  cli: ForgeCliClient = new ForgeCliClient()
): void {
  const deps: ForgeReviewCommandDeps = {
    cli,
    reviewReader,
    picker: realPicker,
    messages: realMessages,
    config: realConfig,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('forge.review.setMode', (item?: ForgeExplorerItem) =>
      setReviewMode(item, deps)
    ),
    vscode.commands.registerCommand('forge.review.setDefaultMode', (item?: ForgeExplorerItem) =>
      setDefaultReviewMode(item, deps)
    ),
    vscode.commands.registerCommand('forge.review.stop', (item?: ForgeExplorerItem) => stopReview(item, deps))
  );
}
