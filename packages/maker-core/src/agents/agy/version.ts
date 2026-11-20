/**
 * agy binary preflight: missing / too old diagnostics, without falling back to another runtime.
 *
 * `agy acp` first shipped in the 1.5 line; 1.0.x prints its generic usage and exits
 * instead of serving ACP, which would otherwise surface as an opaque transport error.
 */
import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';

export const AGY_MIN_VERSION = '1.5.0';

export class AgyBinaryUnavailableError extends Error {
  constructor(message: string, readonly code: 'agy_binary_missing' | 'agy_binary_too_old' | 'agy_version_unknown') {
    super(message);
    this.name = 'AgyBinaryUnavailableError';
  }
}

export function parseAgyVersion(output: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export type AgyVersionReader = (binaryPath: string) => Promise<string>;

export function readAgyVersionOutput(command: string, args: readonly string[] = ['--version'],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, timeout: 15_000, shell: false, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

const cache = new Map<string, { mtimeMs: number; size: number; version: string }>();

/** Resolve and gate the installed agy version. Cached per binary path + file identity. */
export async function assertAgyBinaryUsable(binaryPath: string, reader: AgyVersionReader = readAgyVersionOutput): Promise<string> {
  let info;
  try {
    info = await stat(binaryPath);
    await access(binaryPath, constants.X_OK);
  } catch {
    throw new AgyBinaryUnavailableError(
      `Antigravity CLI (agy) was not found or is not executable at ${binaryPath}. Install it on this computer, then reopen the task.`,
      'agy_binary_missing');
  }
  const cached = cache.get(binaryPath);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.version;
  let output: string;
  try { output = await reader(binaryPath); } catch {
    throw new AgyBinaryUnavailableError(`Could not read the Antigravity CLI version from ${binaryPath}.`, 'agy_version_unknown');
  }
  const parsed = parseAgyVersion(output);
  if (!parsed) throw new AgyBinaryUnavailableError(`Could not read the Antigravity CLI version from ${binaryPath}.`, 'agy_version_unknown');
  const version = parsed.join('.');
  if (compareVersions(parsed, parseAgyVersion(AGY_MIN_VERSION)!) < 0) {
    throw new AgyBinaryUnavailableError(
      `Antigravity CLI ${version} does not support ACP. Cindy needs agy ${AGY_MIN_VERSION} or newer; run "agy update" on this computer.`,
      'agy_binary_too_old');
  }
  cache.set(binaryPath, { mtimeMs: info.mtimeMs, size: info.size, version });
  return version;
}

export function clearAgyVersionCache(): void { cache.clear(); }
