/**
 * One Antigravity sign-in per account directory (cindy#1 7121057746, 7122577933).
 *
 * The CLI keeps one sign-in per data directory. An account the host selected gets its own
 * directory, `<account dir>/gemini`:
 *  - Linux (system sandbox): the account directory is the sandbox's private state root, so that
 *    folder is what the CLI sees as `~/.gemini`. The computer's own CLI sign-in is not shown.
 *  - Windows and macOS (no system sandbox): the CLI is started with `--gemini-dir`. On Windows
 *    the CLI normally keeps its sign-in in the system credential store, one entry for the whole
 *    user, whatever the data directory. It keeps the sign-in in a file in the data directory
 *    instead when it sees a remote-shell session (observed on CLI 1.5.15; not documented). The
 *    host sets that signal, and checks before each first use of a CLI build that it still works:
 *    see `assertAgyAccountSignInIsSeparate` in index.ts.
 */
import path from 'node:path';

/** The CLI data directory of an account, inside the account directory. */
export function agyAccountDataDir(accountDir: string): string {
  return path.join(accountDir, 'gemini');
}

/** CLI arguments that point an unsandboxed launch at the account's data directory. */
export function agyAccountCliArgs(accountDir: string): string[] {
  return ['--gemini-dir', agyAccountDataDir(accountDir)];
}

/**
 * Makes the CLI keep its sign-in in the data directory and not in the system credential store.
 * Commands the CLI runs inherit it; a tool that changes its behaviour in a remote shell will do
 * so in an account's task (known limit, recorded in antigravity-native-acp.md).
 */
export const AGY_ACCOUNT_FILE_SIGN_IN_ENV = { SSH_CONNECTION: 'cindy-agy-account' } as const;

export class AgyAccountSignInNotSeparateError extends Error {
  readonly reason = 'agy_account_sign_in_not_separate';
  constructor(detail: 'signed-in-without-account' | 'check-failed', cause?: unknown) {
    // Draft wording, to be replaced by JJ's.
    super(detail === 'signed-in-without-account'
      ? 'Antigravity CLI (agy) on this computer does not keep each account\'s sign-in separate, so Cindy did not start it with this account. Use the computer\'s own Antigravity sign-in, or update Cindy.'
      : 'Cindy could not confirm that Antigravity CLI (agy) keeps this account\'s sign-in separate, so it did not start it with this account.',
      cause === undefined ? undefined : { cause });
    this.name = 'AgyAccountSignInNotSeparateError';
  }
}
