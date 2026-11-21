import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The desktop host supplies its installed resources path. Standalone maker-core
// development and tests use the executable staged by the workspace build.
export function windowsAcpLaunch(binary: string, args: readonly string[], cwd: string,
  env: NodeJS.ProcessEnv, helperPath?: string) {
  const helper = helperPath ?? fileURLToPath(new URL('../../../../../apps/desktop/resources/tools/agy/cindy-agy-job.exe', import.meta.url));
  if (!path.isAbsolute(helper)) throw new Error('Windows helper path must be absolute');
  const quote = (arg: string) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
  return { binary: helper, args: [String(process.pid), cwd, binary, [binary, ...args].map(quote).join(' ')],
    cwd: path.dirname(helper), env };
}

export const WINDOWS_HELPER_START_FAILED = 'The Windows helper could not start Antigravity. Try again. If this keeps happening, reinstall Cindy.';
export const WINDOWS_HELPER_STOPPED = 'The Antigravity Windows helper stopped unexpectedly. Send another message to try again.';
