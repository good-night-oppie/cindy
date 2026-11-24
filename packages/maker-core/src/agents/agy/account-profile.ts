/**
 * One Antigravity sign-in per account directory (cindy#1 7121057746, 7122577933; review cindy#24
 * 7122987514).
 *
 * The CLI keeps one sign-in per data directory. An account the host selected gets its own
 * directory, `<account dir>/gemini`:
 *  - Linux (system sandbox, both permission paths): the account directory is the sandbox's
 *    private state root, so that folder is what the CLI sees as `~/.gemini`. The computer's own
 *    CLI sign-in is not shown, and nothing falls back to it.
 *  - Windows (no system sandbox): the CLI is started with `--gemini-dir`. The CLI normally keeps
 *    its sign-in in the system credential store, one entry for the whole user, whatever the data
 *    directory. It keeps the sign-in in a file in the data directory instead when it sees a
 *    remote-shell session (observed on CLI 1.5.15; not documented). The host sets that marker,
 *    and checks that it still works: see `assertAgyAccountSignInIsSeparate` in index.ts.
 *  - macOS and any other host without the system sandbox: not observed, so not started.
 */
import path from 'node:path';

/** The CLI data directory of an account, inside the account directory. */
export function agyAccountDataDir(accountDir: string): string {
  return path.join(accountDir, 'gemini');
}

const DATA_DIR_FLAG = '--gemini-dir';

/** CLI arguments that point an unsandboxed launch at the account's data directory. */
export function agyAccountCliArgs(accountDir: string): string[] {
  return [DATA_DIR_FLAG, agyAccountDataDir(accountDir)];
}

/** The same launch arguments, with another account directory in place of the one they name. */
export function agyArgsForAccountDir(args: readonly string[], accountDir: string): string[] {
  const at = args.indexOf(DATA_DIR_FLAG);
  if (at < 0 || at + 1 >= args.length) throw new Error('agy launch arguments name no account data directory');
  return args.map((arg, index) => index === at + 1 ? agyAccountDataDir(accountDir) : arg);
}

/** Hosts without the system sandbox on which an account's own sign-in file was observed to work. */
export function agyAccountHostLaunchVerified(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

/**
 * Makes the CLI keep its sign-in in the data directory and not in the system credential store.
 * A marker that is already there (Cindy itself runs in a remote shell) is kept as it is;
 * otherwise the marker has the standard four-field shape, naming this computer only. Commands
 * the CLI runs inherit it; a tool that changes its behaviour in a remote shell will do so in an
 * account's task (known limit, recorded in antigravity-native-acp.md).
 */
export function agyAccountSignInEnv(processEnv: NodeJS.ProcessEnv): { SSH_CONNECTION: string } {
  return { SSH_CONNECTION: processEnv.SSH_CONNECTION?.trim() || '127.0.0.1 0 127.0.0.1 0' };
}

export type AgyAccountSignInNotSeparateDetail = 'signed-in-without-account' | 'check-failed' | 'platform-not-verified';

export class AgyAccountSignInNotSeparateError extends Error {
  readonly reason = 'agy_account_sign_in_not_separate';
  constructor(readonly detail: AgyAccountSignInNotSeparateDetail, cause?: unknown) {
    // Draft wording, to be replaced by JJ's.
    super(detail === 'signed-in-without-account'
      ? 'Antigravity CLI (agy) on this computer does not keep each account\'s sign-in separate, so Cindy did not start it with this account. Use the computer\'s own Antigravity sign-in, or update Cindy.'
      : detail === 'platform-not-verified'
      ? 'Using more than one Antigravity account is not available on this kind of computer yet, so Cindy did not start Antigravity CLI (agy) with this account.'
      : 'Cindy could not confirm that Antigravity CLI (agy) keeps this account\'s sign-in separate, so it did not start it with this account.',
      cause === undefined ? undefined : { cause });
    this.name = 'AgyAccountSignInNotSeparateError';
  }
}
