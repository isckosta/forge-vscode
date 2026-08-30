import { execFile } from 'child_process';

/**
 * Normative Forge operations (operations that change what Forge considers
 * true about a Change, such as requesting a Review mode or stopping a
 * Review) are delegated to the Forge CLI rather than performed by the
 * extension, per this repository's "Forge CLI" integration strategy: the
 * extension must not reimplement or fabricate authoritative Forge state.
 *
 * `forge review set-mode <changeId> <mode>` and `forge review stop
 * <changeId>` are this extension's working assumption about the CLI's
 * public surface, in the same spirit as `forge validate`/`forge doctor`
 * already documented for this integration. If the Forge CLI's actual
 * surface differs, only this client needs to change.
 */

export interface ForgeCliProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface ForgeCliRunner {
  run(args: readonly string[], cwd: string): Promise<ForgeCliProcessResult>;
}

export type ForgeCliResult =
  | { readonly kind: 'success'; readonly stdout: string }
  | { readonly kind: 'cli-not-found' }
  | { readonly kind: 'execution-failed'; readonly message: string };

const CLI_COMMAND = 'forge';

class ExecFileRunner implements ForgeCliRunner {
  run(args: readonly string[], cwd: string): Promise<ForgeCliProcessResult> {
    return new Promise((resolve, reject) => {
      execFile(CLI_COMMAND, args, { cwd }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(error);
          return;
        }
        const exitCode = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ stdout, stderr, exitCode });
      });
    });
  }
}

const defaultRunner: ForgeCliRunner = new ExecFileRunner();

export class ForgeCliClient {
  constructor(private readonly runner: ForgeCliRunner = defaultRunner) {}

  async run(args: readonly string[], cwd: string): Promise<ForgeCliResult> {
    let result: ForgeCliProcessResult;
    try {
      result = await this.runner.run(args, cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return { kind: 'cli-not-found' };
      }
      return {
        kind: 'execution-failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.exitCode !== 0) {
      return {
        kind: 'execution-failed',
        message: result.stderr.trim().length > 0 ? result.stderr.trim() : `forge exited with code ${result.exitCode}`,
      };
    }

    return { kind: 'success', stdout: result.stdout };
  }
}
