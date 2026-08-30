import * as vscode from 'vscode';
import * as YAML from 'yaml';

/**
 * Repository-native projection of Forge's Review state for a single Change.
 *
 * This mirrors `ForgeChangeDiscovery`'s "repository reading" mechanism: the
 * extension reads and validates `.forge/changes/<id>/review/state.yml`, it
 * does not decide review semantics. `mode` and `effectiveProfile` are kept
 * distinct on purpose — the UI exposes only the three UX modes
 * (Recommended/Fast/Thorough) while Forge continues to resolve whatever
 * internal profile (strict/standard/Flow-specific/...) actually governs the
 * Change, so a reduction in assurance required by Flow/Contract is always
 * visible rather than silently absorbed by the UI-level mode choice.
 *
 * The `forge/review@1` schema below is this extension's working assumption
 * about a public Forge repository contract, following the same posture as
 * `ForgeWorkspaceDetector`'s reliance on `.forge/forge.yml`: a practical
 * contract this extension depends on without elevating it to a permanent
 * Protocol invariant. If forge-protocol's public schema differs, this
 * reader should be updated to match it rather than the other way around.
 */

export interface ForgeReviewFileSystem {
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
}

export type ForgeReviewMode = 'recommended' | 'fast' | 'thorough';
export type ForgeReviewStage = 'discovery' | 'findings' | 'resolution' | 're-review' | 'concluded';
export type ForgeReviewFindingStatus = 'open' | 'resolved';
export type ForgeReviewConcludedResult = 'clear' | 'stopped-with-open-findings' | 'stopped';

export interface ForgeReviewFinding {
  readonly id: string;
  readonly status: ForgeReviewFindingStatus;
  readonly blocking: boolean;
  readonly summary: string;
  readonly evidenceUri?: vscode.Uri;
}

export interface ForgeReviewConcluded {
  readonly result: ForgeReviewConcludedResult;
  readonly openFindingsCount: number;
  /**
   * Explicit rather than inferred, so the UI never has to guess whether a
   * concluded review may be presented as a success.
   */
  readonly canClaimSuccess: boolean;
}

export interface ForgeReview {
  readonly mode: ForgeReviewMode;
  readonly effectiveProfile: string;
  readonly effectiveProfileReason?: string;
  readonly stage: ForgeReviewStage;
  readonly summary?: string;
  readonly remaining?: string;
  readonly findings: readonly ForgeReviewFinding[];
  readonly concluded?: ForgeReviewConcluded;
}

export type ForgeReviewResult =
  | { readonly kind: 'success'; readonly review: ForgeReview }
  | { readonly kind: 'not-started' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

const INVALID_MESSAGE = 'Review state is invalid.';
const UNAVAILABLE_MESSAGE = 'Review state is unavailable.';
const SUPPORTED_SCHEMAS = new Set(['forge/review@1']);
const MODES = new Set<ForgeReviewMode>(['recommended', 'fast', 'thorough']);
const STAGES = new Set<ForgeReviewStage>([
  'discovery',
  'findings',
  'resolution',
  're-review',
  'concluded',
]);
const FINDING_STATUSES = new Set<ForgeReviewFindingStatus>(['open', 'resolved']);
const CONCLUDED_RESULTS = new Set<ForgeReviewConcludedResult>([
  'clear',
  'stopped-with-open-findings',
  'stopped',
]);

const defaultFileSystem: ForgeReviewFileSystem = {
  readFile: (uri) => vscode.workspace.fs.readFile(uri),
};

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof vscode.FileSystemError && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseFinding(value: unknown, changeReviewUri: vscode.Uri): ForgeReviewFinding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, status, blocking, summary, evidenceUri } = value;
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  if (typeof status !== 'string' || !FINDING_STATUSES.has(status as ForgeReviewFindingStatus)) {
    return undefined;
  }
  if (typeof blocking !== 'boolean') {
    return undefined;
  }
  if (typeof summary !== 'string') {
    return undefined;
  }
  if (evidenceUri !== undefined && typeof evidenceUri !== 'string') {
    return undefined;
  }

  return {
    id,
    status: status as ForgeReviewFindingStatus,
    blocking,
    summary,
    evidenceUri:
      typeof evidenceUri === 'string'
        ? vscode.Uri.joinPath(changeReviewUri, evidenceUri)
        : undefined,
  };
}

function parseConcluded(value: unknown): ForgeReviewConcluded | undefined | 'invalid' {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return 'invalid';
  }
  const { result, openFindingsCount, canClaimSuccess } = value;
  if (typeof result !== 'string' || !CONCLUDED_RESULTS.has(result as ForgeReviewConcludedResult)) {
    return 'invalid';
  }
  if (typeof openFindingsCount !== 'number' || !Number.isInteger(openFindingsCount) || openFindingsCount < 0) {
    return 'invalid';
  }
  if (typeof canClaimSuccess !== 'boolean') {
    return 'invalid';
  }
  return { result: result as ForgeReviewConcludedResult, openFindingsCount, canClaimSuccess };
}

function parseReview(value: unknown, changeReviewUri: vscode.Uri): ForgeReview | undefined {
  if (!isRecord(value) || typeof value.schema !== 'string' || !SUPPORTED_SCHEMAS.has(value.schema)) {
    return undefined;
  }
  if (!isRecord(value.review)) {
    return undefined;
  }

  const { mode, effectiveProfile, effectiveProfileReason, stage, summary, remaining, findings, concluded } =
    value.review;

  if (typeof mode !== 'string' || !MODES.has(mode as ForgeReviewMode)) {
    return undefined;
  }
  if (typeof effectiveProfile !== 'string' || effectiveProfile.length === 0) {
    return undefined;
  }
  if (effectiveProfileReason !== undefined && typeof effectiveProfileReason !== 'string') {
    return undefined;
  }
  if (typeof stage !== 'string' || !STAGES.has(stage as ForgeReviewStage)) {
    return undefined;
  }
  if (summary !== undefined && typeof summary !== 'string') {
    return undefined;
  }
  if (remaining !== undefined && typeof remaining !== 'string') {
    return undefined;
  }
  if (findings !== undefined && !Array.isArray(findings)) {
    return undefined;
  }

  const parsedFindings: ForgeReviewFinding[] = [];
  for (const entry of (findings as unknown[] | undefined) ?? []) {
    const finding = parseFinding(entry, changeReviewUri);
    if (!finding) {
      return undefined;
    }
    parsedFindings.push(finding);
  }

  const parsedConcluded = parseConcluded(concluded);
  if (parsedConcluded === 'invalid') {
    return undefined;
  }

  return {
    mode: mode as ForgeReviewMode,
    effectiveProfile,
    effectiveProfileReason: effectiveProfileReason as string | undefined,
    stage: stage as ForgeReviewStage,
    summary: summary as string | undefined,
    remaining: remaining as string | undefined,
    findings: parsedFindings,
    concluded: parsedConcluded,
  };
}

export class ForgeReviewReader {
  constructor(private readonly fileSystem: ForgeReviewFileSystem = defaultFileSystem) {}

  async discover(folder: vscode.WorkspaceFolder, changeId: string): Promise<ForgeReviewResult> {
    const reviewDirUri = vscode.Uri.joinPath(folder.uri, '.forge', 'changes', changeId, 'review');
    const stateUri = vscode.Uri.joinPath(reviewDirUri, 'state.yml');

    let contents: Uint8Array;
    try {
      contents = await this.fileSystem.readFile(stateUri);
    } catch (error) {
      if (isFileSystemError(error, 'FileNotFound') || isFileSystemError(error, 'FileNotADirectory')) {
        return { kind: 'not-started' };
      }
      return { kind: 'unavailable', message: UNAVAILABLE_MESSAGE };
    }

    let parsed: unknown;
    try {
      parsed = YAML.parse(new TextDecoder().decode(contents));
    } catch {
      return { kind: 'invalid', message: INVALID_MESSAGE };
    }

    const review = parseReview(parsed, reviewDirUri);
    if (!review) {
      return { kind: 'invalid', message: INVALID_MESSAGE };
    }

    return { kind: 'success', review };
  }
}
