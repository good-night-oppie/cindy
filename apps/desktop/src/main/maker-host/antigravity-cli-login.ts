import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ANTIGRAVITY_CLI_DIR_SEGMENTS } from '../../shared/localCliDetect.js';

/** Where the CLI keeps its Google sign-in on Windows: a generic credential with this target. */
const WINDOWS_CREDENTIAL_TARGET = 'gemini:antigravity';
const WINDOWS_CACHE_MS = 30_000;
let windowsCache: { at: number; value: boolean } | null = null;

/**
 * Asks Windows Credential Manager whether the CLI's credential exists. `cmdkey /list` prints
 * targets and user names only, never the secret. Cached briefly: the provider list is read often.
 */
function hasWindowsCredential(): boolean {
  if (windowsCache && Date.now() - windowsCache.at < WINDOWS_CACHE_MS) return windowsCache.value;
  let value = false;
  try {
    const out = execFileSync('cmdkey', [`/list:${WINDOWS_CREDENTIAL_TARGET}`], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    value = /Target:\s*(LegacyGeneric:target=)?gemini:antigravity/i.test(out);
  } catch {
    value = false;
  }
  windowsCache = { at: Date.now(), value };
  return value;
}

/**
 * Whether the Antigravity CLI on this computer holds its own Google sign-in.
 *
 * Existence check only: the CLI owns this credential and talks to Google itself. Cindy never
 * reads, copies or forwards it, so a Google AI subscription is only ever used through the CLI.
 * Linux keeps it in a file under ~/.gemini; Windows keeps it in Credential Manager.
 */
export function hasAntigravityCliLogin(home: string = homedir()): boolean {
  try {
    if (statSync(join(home, ...ANTIGRAVITY_CLI_DIR_SEGMENTS, 'antigravity-oauth-token')).isFile()) return true;
  } catch {
    // Not stored as a file on this platform.
  }
  return process.platform === 'win32' ? hasWindowsCredential() : false;
}
