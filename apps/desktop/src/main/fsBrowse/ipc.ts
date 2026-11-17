/** Electron adapter for the shared, platform-independent filesystem browsing helpers. */

import { ipcMain } from 'electron';

import * as path from 'node:path';
import { throwIpcError, requireObject, requireString } from '../utils/ipcValidate.js';
import { agyHostPathRefusal } from '../agyHostPathGuard.js';
import { listDir, mkdirP, statPath } from './core.js';

export * from './core.js';

/** Register the local and Device Link project-directory browsing handlers. */
export function registerFsBrowseIpc(): void {
  ipcMain.handle('fs:list-dir', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    const dir = requireString(obj.path, 'path');
    // agy task folder (cindy#1): a folder link out of it is not listed.
    const agyRefusal = path.isAbsolute(dir) ? agyHostPathRefusal(dir) : null;
    if (agyRefusal) throwIpcError('FS_BROWSE_FAILED', agyRefusal);
    return listDir(dir, { canonicalDirectory: obj.canonicalDirectory === true });
  });
  ipcMain.handle('fs:stat-path', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return statPath(requireString(obj.path, 'path'), obj.canonicalDirectory === true);
  });
  ipcMain.handle('fs:mkdir-p', async (_e, arg: unknown) => {
    const obj = requireObject(arg);
    return mkdirP(requireString(obj.path, 'path'));
  });
}
