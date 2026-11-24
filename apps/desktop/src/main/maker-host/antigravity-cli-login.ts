import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
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
/** The Antigravity CLI this computer runs: an explicit override, its usual install place, or PATH. */
export function resolveAntigravityCliBinary(): string {
  const override = process.env['CINDY_AGY_BINARY'];
  if (override && override.trim()) return override.trim();
  const candidates = process.platform === 'win32'
    ? [process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'agy', 'bin', 'agy.exe') : '']
    : ['/usr/local/bin/agy', join(homedir(), '.local', 'bin', 'agy')];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}

/**
 * Whether an additional Antigravity account directory holds a sign-in (existence check only).
 * Such an account always keeps its sign-in in a file in its own CLI data directory, on every
 * platform; see packages/maker-core/src/agents/agy/account-profile.ts.
 */
export function hasAntigravityAccountLogin(accountDir: string): boolean {
  try {
    return statSync(join(accountDir, 'gemini', 'antigravity-cli', 'antigravity-oauth-token')).isFile();
  } catch {
    return false;
  }
}

export function hasAntigravityCliLogin(home: string = homedir()): boolean {
  try {
    if (statSync(join(home, ...ANTIGRAVITY_CLI_DIR_SEGMENTS, 'antigravity-oauth-token')).isFile()) return true;
  } catch {
    // Not stored as a file on this platform.
  }
  return process.platform === 'win32' ? hasWindowsCredential() : false;
}
