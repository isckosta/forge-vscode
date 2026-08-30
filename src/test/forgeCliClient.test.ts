import * as assert from 'assert';
import { ForgeCliClient, ForgeCliProcessResult, ForgeCliRunner } from '../forge/cli/ForgeCliClient';

class StubRunner implements ForgeCliRunner {
  public lastArgs?: readonly string[];
  public lastCwd?: string;

  constructor(
    private readonly result?: ForgeCliProcessResult,
    private readonly error?: Error
  ) {}

  async run(args: readonly string[], cwd: string): Promise<ForgeCliProcessResult> {
    this.lastArgs = args;
    this.lastCwd = cwd;
    if (this.error) {
      throw this.error;
    }
    return this.result!;
  }
}

function enoent(): NodeJS.ErrnoException {
  const error = new Error('spawn forge ENOENT') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

suite('ForgeCliClient', () => {
  test('returns success with stdout on a zero exit code', async () => {
    const runner = new StubRunner({ stdout: 'ok', stderr: '', exitCode: 0 });
    const client = new ForgeCliClient(runner);

    const result = await client.run(['review', 'set-mode', 'CHG-0001', 'fast'], '/workspace');

    assert.deepStrictEqual(result, { kind: 'success', stdout: 'ok' });
    assert.deepStrictEqual(runner.lastArgs, ['review', 'set-mode', 'CHG-0001', 'fast']);
    assert.strictEqual(runner.lastCwd, '/workspace');
  });

  test('reports cli-not-found when the binary cannot be spawned', async () => {
    const runner = new StubRunner(undefined, enoent());
    const client = new ForgeCliClient(runner);

    assert.deepStrictEqual(await client.run(['review', 'stop', 'CHG-0001'], '/workspace'), {
      kind: 'cli-not-found',
    });
  });

  test('reports execution-failed with stderr on a non-zero exit code', async () => {
    const runner = new StubRunner({ stdout: '', stderr: 'Change not found', exitCode: 1 });
    const client = new ForgeCliClient(runner);

    assert.deepStrictEqual(await client.run(['review', 'stop', 'CHG-9999'], '/workspace'), {
      kind: 'execution-failed',
      message: 'Change not found',
    });
  });

  test('reports execution-failed with a generic message when stderr is empty', async () => {
    const runner = new StubRunner({ stdout: '', stderr: '   ', exitCode: 2 });
    const client = new ForgeCliClient(runner);

    assert.deepStrictEqual(await client.run(['review', 'stop', 'CHG-9999'], '/workspace'), {
      kind: 'execution-failed',
      message: 'forge exited with code 2',
    });
  });

  test('reports execution-failed for unexpected runner errors', async () => {
    const runner = new StubRunner(undefined, new Error('boom'));
    const client = new ForgeCliClient(runner);

    assert.deepStrictEqual(await client.run(['review', 'stop', 'CHG-0001'], '/workspace'), {
      kind: 'execution-failed',
      message: 'boom',
    });
  });
});
