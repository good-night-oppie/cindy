/**
 * Desktop side of the agy host path guard (good-night-oppie/cindy#1, QQ 6924350879 item 5).
 *
 * Every desktop entry that reads, lists or uploads something that may sit in an agy task folder goes
 * through maker-core's `checkAgyTaskPath` — the one check — directly or via these thin wrappers, which
 * only add the UI locale for JJ's refusal sentence. While no agy session is open the check returns null
 * and every entry behaves exactly as before. The entry list is in the PR body (and asserted by
 * __tests__/agyHostPathGuardEntries.test.ts).
 */
import {
  AgyLinkOutsideTaskError, checkAgyTaskPath, isAgyLinkOutsideTaskError, listAgyTaskDir, openAgyTaskFile,
  readAgyTaskFile, verifyAgyTaskHandle, type AgyTaskEntry, type AgyTaskPathCheck,
} from '@cindy/maker-core/agy-host-path-guard';
import type { FileHandle } from 'node:fs/promises';

let localeSource: () => string | null | undefined = () => undefined;

/** Wired once at startup to the main-process UI locale. */
export function setAgyHostPathLocale(source: () => string | null | undefined): void {
  localeSource = source;
}

function locale(): string | null | undefined {
  try { return localeSource(); } catch { return undefined; }
}

/** The one check, with the UI locale. Throws AgyLinkOutsideTaskError; null = not in an agy task folder. */
export function checkAgyHostPath(target: string, taskDir?: string): AgyTaskPathCheck | null {
  return checkAgyTaskPath(target, { taskDir, locale: locale() });
}

/** The refusal sentence for the user when `target` is refused, else null. Never throws. */
export function agyHostPathRefusal(target: string, taskDir?: string): string | null {
  try { checkAgyHostPath(target, taskDir); return null; } catch (error) {
    if (isAgyLinkOutsideTaskError(error)) return error.message;
    // Unexpected filesystem error while resolving: refuse rather than read unchecked.
    return new AgyLinkOutsideTaskError(target, 'unresolved', taskDir ?? '', locale()).message;
  }
}

/** Open for reading: inside an agy task folder this checks, opens without following, and checks the handle. */
export async function openHostFileForRead(target: string, taskDir?: string): Promise<FileHandle> {
  return (await openAgyTaskFile(target, { taskDir, locale: locale() })).handle;
}

/** After an entry's own open: the handle must still be inside the agy task folder. Closes it and throws if not. */
export async function verifyHostHandle(handle: FileHandle, target: string, taskDir?: string): Promise<void> {
  try { await verifyAgyTaskHandle(handle, target, { taskDir, locale: locale() }); } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export function readHostFile(target: string, taskDir?: string): Promise<Buffer> {
  return readAgyTaskFile(target, { taskDir, locale: locale() });
}

export function listHostDir(target: string, taskDir?: string): Promise<AgyTaskEntry[]> {
  return listAgyTaskDir(target, { taskDir, locale: locale() });
}

export { isAgyLinkOutsideTaskError };
