import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ANTIGRAVITY_CLI_DIR_SEGMENTS } from '../../shared/localCliDetect.js';

/**
 * Whether the Antigravity CLI on this computer holds its own Google sign-in.
 *
 * Existence check only: the CLI owns this credential and talks to Google itself. Cindy never
 * reads, copies or forwards it, so a Google AI subscription is only ever used through the CLI.
 */
export function hasAntigravityCliLogin(home: string = homedir()): boolean {
  try {
    return statSync(join(home, ...ANTIGRAVITY_CLI_DIR_SEGMENTS, 'antigravity-oauth-token')).isFile();
  } catch {
    return false;
  }
}
