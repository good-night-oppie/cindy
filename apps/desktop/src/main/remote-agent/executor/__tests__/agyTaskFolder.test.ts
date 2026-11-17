/**
 * QQ R3 on cindy#15: the remote-agent executor reads local files for a remote agent. When its working
 * folder is (or once was) an agy task folder, a link agy left there must not lead it outside.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { registerAgyTaskDir, setAgyTaskDirStoreFile } from '@cindy/maker-core/agy-host-path-guard';

import { RemoteExecutor } from '../executor';
import { ExecutorGate } from '../gate';
import { ExecutorWorkspace } from '../workspace';

const posix = process.platform !== 'win32';
const RG = path.resolve(__dirname, '../../../../../../ripgrep-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-exec-agy-')));
setAgyTaskDirStoreFile(path.join(root, 'task-dirs.json'));
afterAll(() => { setAgyTaskDirStoreFile(null); fs.rmSync(root, { recursive: true, force: true }); });

describe('remote-agent executor in an agy task folder', () => {
  it.skipIf(!posix)('refuses fs.read / fs.stat / fs.readdir / Read through a link out of the folder', async () => {
    const project = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'config'), 'SECRET');
    fs.writeFileSync(path.join(project, 'ok.txt'), 'fine');
    fs.symlinkSync(path.join(outside, 'config'), path.join(project, 'link-to-config'));
    fs.symlinkSync(outside, path.join(project, 'link-to-dir'));
    registerAgyTaskDir(project)(); // agy ran here once; its session is over

    const workspace = new ExecutorWorkspace({ workingDir: project });
    const executor = new RemoteExecutor({
      workspace, gate: new ExecutorGate(workspace, 'full'), rgPath: RG, tempDir: path.join(root, 'tmp'),
      capture: { beforeWrite: async () => {}, noteOpaqueWrite: () => {} },
    });
    await expect(executor.handle('fs.read', { path: 'link-to-config' })).rejects.toMatchObject({ code: 'EACCES' });
    await expect(executor.handle('fs.stat', { path: 'link-to-config' })).rejects.toMatchObject({ code: 'EACCES' });
    await expect(executor.handle('fs.readdir', { path: 'link-to-dir' })).rejects.toMatchObject({ code: 'EACCES' });
    const read = await executor.callTool('Read', { file_path: path.join(project, 'link-to-config') });
    expect(read.isError).toBe(true);
    expect(JSON.stringify(read)).not.toContain('SECRET');
    expect(Buffer.from(((await executor.handle('fs.read', { path: 'ok.txt' })) as { data: string }).data, 'base64').toString()).toBe('fine');
  });
});
