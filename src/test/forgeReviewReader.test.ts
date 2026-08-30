import * as assert from 'assert';
import * as vscode from 'vscode';
import { ForgeReviewFileSystem, ForgeReviewReader } from '../forge/review/ForgeReviewReader';

class StubFileSystem implements ForgeReviewFileSystem {
  constructor(
    private readonly contents?: string,
    private readonly readFileError?: Error
  ) {}

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    void uri;
    if (this.readFileError) {
      throw this.readFileError;
    }
    if (this.contents === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return new TextEncoder().encode(this.contents);
  }
}

function workspaceFolder(): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 };
}

suite('ForgeReviewReader', () => {
  test('returns not-started when review state is absent', async () => {
    const reader = new ForgeReviewReader(new StubFileSystem());

    assert.deepStrictEqual(await reader.discover(workspaceFolder(), 'CHG-0001'), { kind: 'not-started' });
  });

  test('discovers a valid review state with findings and no conclusion', async () => {
    const reader = new ForgeReviewReader(
      new StubFileSystem(
        [
          'schema: forge/review@1',
          'review:',
          '  mode: fast',
          '  effectiveProfile: standard',
          '  stage: resolution',
          '  summary: Resolving 2 open findings',
          '  remaining: Targeted re-review of resolved findings',
          '  findings:',
          '    - id: F-001',
          '      status: resolved',
          '      blocking: false',
          '      summary: Unused import',
          '    - id: F-002',
          '      status: open',
          '      blocking: true',
          '      summary: Missing authorization check',
          '      evidenceUri: evidence/F-002.md',
          '',
        ].join('\n')
      )
    );

    const result = await reader.discover(workspaceFolder(), 'CHG-0001');

    assert.strictEqual(result.kind, 'success');
    assert.ok(result.kind === 'success');
    assert.strictEqual(result.review.mode, 'fast');
    assert.strictEqual(result.review.effectiveProfile, 'standard');
    assert.strictEqual(result.review.stage, 'resolution');
    assert.strictEqual(result.review.findings.length, 2);
    assert.strictEqual(result.review.findings[1]?.blocking, true);
    assert.strictEqual(
      result.review.findings[1]?.evidenceUri?.toString(),
      vscode.Uri.file('/workspace/.forge/changes/CHG-0001/review/evidence/F-002.md').toString()
    );
    assert.strictEqual(result.review.concluded, undefined);
  });

  test('discovers a concluded review that is not a pass', async () => {
    const reader = new ForgeReviewReader(
      new StubFileSystem(
        [
          'schema: forge/review@1',
          'review:',
          '  mode: recommended',
          '  effectiveProfile: strict',
          '  effectiveProfileReason: Required by Engineering Contract for payment flows',
          '  stage: concluded',
          '  findings:',
          '    - id: F-001',
          '      status: open',
          '      blocking: true',
          '      summary: Missing authorization check',
          '  concluded:',
          '    result: stopped-with-open-findings',
          '    openFindingsCount: 1',
          '    canClaimSuccess: false',
          '',
        ].join('\n')
      )
    );

    const result = await reader.discover(workspaceFolder(), 'CHG-0001');

    assert.strictEqual(result.kind, 'success');
    assert.ok(result.kind === 'success');
    assert.strictEqual(result.review.effectiveProfileReason, 'Required by Engineering Contract for payment flows');
    assert.deepStrictEqual(result.review.concluded, {
      result: 'stopped-with-open-findings',
      openFindingsCount: 1,
      canClaimSuccess: false,
    });
  });

  test('returns invalid for malformed YAML', async () => {
    const reader = new ForgeReviewReader(new StubFileSystem('schema: ['));

    assert.deepStrictEqual(await reader.discover(workspaceFolder(), 'CHG-0001'), {
      kind: 'invalid',
      message: 'Review state is invalid.',
    });
  });

  test('returns invalid for unsupported schema, mode, stage, and finding shapes', async () => {
    const invalidDocuments = [
      'schema: forge/review@2\nreview:\n  mode: fast\n  effectiveProfile: standard\n  stage: discovery\n',
      'schema: forge/review@1\nreview:\n  mode: strict\n  effectiveProfile: standard\n  stage: discovery\n',
      'schema: forge/review@1\nreview:\n  mode: fast\n  effectiveProfile: standard\n  stage: unknown-stage\n',
      'schema: forge/review@1\nreview:\n  mode: fast\n  effectiveProfile: standard\n  stage: discovery\n  findings:\n    - id: F-001\n      status: pending\n      blocking: false\n      summary: x\n',
      'schema: forge/review@1\nreview:\n  mode: fast\n  stage: discovery\n',
    ];

    for (const document of invalidDocuments) {
      const reader = new ForgeReviewReader(new StubFileSystem(document));
      assert.deepStrictEqual(await reader.discover(workspaceFolder(), 'CHG-0001'), {
        kind: 'invalid',
        message: 'Review state is invalid.',
      });
    }
  });

  test('returns unavailable when the state file cannot be read', async () => {
    const reader = new ForgeReviewReader(
      new StubFileSystem(undefined, vscode.FileSystemError.NoPermissions(vscode.Uri.file('/workspace')))
    );

    assert.deepStrictEqual(await reader.discover(workspaceFolder(), 'CHG-0001'), {
      kind: 'unavailable',
      message: 'Review state is unavailable.',
    });
  });
});
