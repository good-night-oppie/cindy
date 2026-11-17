/**
 * Every host entry that reads, lists or uploads something from a task folder runs the one agy check
 * (good-night-oppie/cindy#1, QQ 6924350879 item 5). This list is the one in the PR body; adding an
 * entry means adding it here. Behavior of the check itself is tested in maker-core
 * (src/agents/agy/host-path-guard.test.ts).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registerAgyTaskDir, setAgyTaskDirStoreFile } from '@cindy/maker-core/agy-host-path-guard';
import { isPathAllowedAgainst } from '../filePathPolicy';
import {
  agyAwareRealpath, agyHandoffPath, agyHostPathRefusal, agyNotInTaskFolderRefusal, notifyAgyHostPathRefusal, openNoFollowForRead,
  setAgyHostPathRefusalNotifier,
} from '../agyHostPathGuard';

const MAIN = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(MAIN, rel), 'utf8');

/** [file, what it guards, the guard call that must appear] */
const ENTRIES: [string, string, RegExp][] = [
  ['filePathPolicy.ts', 'isPathAllowedAgainst: every entry behind the system / sensitive-media policy', /agyHostPathRefusal\(canonicalInput\)/],
  ['bootstrap-electron.ts', 'read-file-for-attachment / peek-file-header / text-file:read-preview', /agyHostPathRefusal\(filePath\)[\s\S]*openHostFileForRead\(filePath\)/],
  ['bootstrap-electron.ts', 'media:copy-to-clipboard', /agyHostPathRefusal\(absPath\)/],
  ['bootstrap-electron.ts', 'lightbox media:read-image-bytes / media:cache-for-session / media:save-as (deps)', /readFile: async \(absPath\) => checkAgyHostPath\(absPath\) \? readHostFile\(absPath\)/],
  ['bootstrap-electron.ts', 'workspace:scan-at-resources / workspace:scan-slash-commands', /agyHostPathRefusal\(agentsDir\)[\s\S]*agyHostPathRefusal\(dirPath\)/],
  // QQ B3: decided from, and opened by, the requested path, not a real path resolved earlier.
  ['localFileProtocol.ts', 'xdt-file://', /notifyAgyHostPathRefusal\(resolved\)[\s\S]*checkAgyHostPath\(resolved\)\) handle = await openHostFileForRead\(resolved\)/],
  ['audioFileProtocol.ts', 'xdt-audio://', /notifyAgyHostPathRefusal\(resolved\)[\s\S]*checkAgyHostPath\(resolved\) \? await readHostFile\(resolved\)/],
  ['bootstrap-electron.ts', 'read-file-bytes (PDF preview)', /realpath: \(p\) => agyAwareRealpath\(p\)[\s\S]*checkAgyHostPath\(p\)\s*\? await openHostFileForRead\(p\)/],
  ['bootstrap-electron.ts', 'chat-attachment:stage (real path and open)', /realpath: \(filePath\) => agyAwareRealpath\(filePath\)[\s\S]*openNoFollowForRead\(filePath\)/],
  ['bootstrap-electron.ts', 'lightbox media:save-as (real path)', /realpath: \(absPath\) => agyAwareRealpath\(absPath\)/],
  ['bootstrap-electron.ts', 'chat-attachment:stage (message) and the refusal push to the renderer', /setAgyHostPathRefusalNotifier\([\s\S]*agyRefusal: \(sourcePath\) => agyNotInTaskFolderRefusal\(sourcePath\)/],
  ['cindy-media/chatAttachmentsCore.ts', 'image-cache:from-path (drag an image in)', /readHostFile\(params\.sourcePath\)/],
  ['file-browser/index.ts', 'maker:file-browser:list-dir / list-all / read-file / stat, maker:chat-folder:upload', /checkAgyHostPath\(resolvePath\(workdir, relPath\)\)[\s\S]*agyHostPathRefusal\(args\.sourcePath\)/],
  ['file-browser/index.ts', 'maker:file-browser:read-file (handle re-check, QQ R1)', /afterOpen: \(handle\) => verifyHostHandle\(handle, resolvePath\(args\.workdir, args\.relPath\)\)/],
  ['file-browser/search/index.ts', 'maker:search:start', /agyHostPathRefusal\(args\.workdir\)/],
  ['file-browser/html-preview-ipc.ts', 'maker:html-preview:open (stat / read)', /checkAgyHostPath\(path\.join\(root, rel\)\)[\s\S]*checkAgyHostPath\(source\)/],
  ['file-browser/html-preview.ts', 'maker:html-preview:open (copy, handle re-check)', /verifyHostHandle\(input, source\)/],
  ['file-browser/device-op.ts', 'device-link file ops: fileUrl / listDir / readFile / stat / listAllFiles / export / thumbnail / searchCollect', /AGY_CHECKED_READ_OPS\.has\(args\.op\)/],
  ['device-link/mediaFetch.ts', 'media:fetch (remote controller pulls a file)', /verifyHostHandle\(file, absPath\)/],
  ['cindy-brain/ghostLocalPathGrant.ts', 'plugin attachment classification (publishImage / pictureRef / local themes)', /checkAgyHostPath\(input\)/],
  ['mcp-integrations/ghost.ts', 'plugin attachments and dir / single-file handoff', /agyHostPathRefusal\(url\)[\s\S]*agyHostPathRefusal\(params\.dirAbs\)/],
  ['cindy-brain/dirDeposit.ts', 'folder upload to a plugin', /agyHostPathRefusal\(dirAbs\)/],
  ['maker-ipc/chatServerMedia.ts', 'attachment upload to the chat server', /checkAgyHostPath\(attachment\.path\)[\s\S]*readHostFile\(attachment\.path\)/],
  ['maker-ipc/normalizeAttachments.ts', 'local image path from a remote controller', /readHostFile\(refStr\)/],
  ['turn-change-set/store.ts', '"files changed" capture after a turn', /checkAgyHostPath\(absolutePath\)/],
  ['cindy-files/register.ts', 'cindy-files:open', /checkAgyHostPath\(filePath\)/],
  ['fsBrowse/ipc.ts', 'fs:list-dir', /agyHostPathRefusal\(dir\)/],
  // QQ R2: entries that hand a path to another program pass the checked real path.
  ['bootstrap-electron.ts', 'shell:open-path', /const errMsg = await shell\.openPath\(agyHandoffPath\(filePath\)\)/],
  ['bootstrap-electron.ts', 'shell:open-file-in-browser', /openPath: \(filePath\) => shell\.openPath\(agyHandoffPath\(filePath\)\)/],
  ['bootstrap-electron.ts', 'open-with:open', /filePath: agyHandoffPath\(params\.filePath\)/],
  ['bootstrap-electron.ts', 'media:open-with-default-app (lightbox)', /openPath: \(absPath\) => shell\.openPath\(agyHandoffPath\(absPath\)\)/],
  ['remote-agent/executor/executor.ts', 'remote-agent executor: fs.* / pi.grep / Read / Write / Edit / exec (QQ R3)', /if \(action\.kind === 'read' \|\| action\.kind === 'write'\) return agyHostPathRefusal\(action\.path\)[\s\S]*const agy = this\.agyRefusal\(action\);\s*if \(agy\) throw new ExecutorRequestError[\s\S]*const agy = this\.agyRefusal\(action\);\s*if \(agy\) throw new ExecutorDenied/],
];

describe('agy task-folder entries all run the one check', () => {
  it.each(ENTRIES)('%s — %s', (file, _what, pattern) => {
    expect(read(file)).toMatch(pattern);
  });
});

const posix = process.platform !== 'win32';

describe('the shared path policy refuses a link out of an agy task folder', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-policy-')));
  setAgyTaskDirStoreFile(path.join(root, 'task-dirs.json'));
  afterAll(() => { setAgyTaskDirStoreFile(null); rmSync(root, { recursive: true, force: true }); });

  it.skipIf(!posix)('refuses the link, allows normal files, does nothing where agy never ran, and keeps refusing after the session', () => {
    const task = path.join(root, 'task');
    mkdirSync(task);
    mkdirSync(path.join(root, 'outside'));
    writeFileSync(path.join(root, 'outside', 'config'), 'SECRET');
    writeFileSync(path.join(task, 'ok.png'), 'x');
    symlinkSync(path.join(root, 'outside', 'config'), path.join(task, 'link-to-config'));
    const link = path.join(task, 'link-to-config');
    expect(isPathAllowedAgainst(link, [])).toBe(true); // no agy session: unchanged
    const release = registerAgyTaskDir(task);
    try {
      expect(isPathAllowedAgainst(link, [])).toBe(false);
      expect(agyHostPathRefusal(link)).toMatch(/^This file is just a link pointing outside the task folder/);
      expect(isPathAllowedAgainst(path.join(task, 'ok.png'), [])).toBe(true);
      expect(isPathAllowedAgainst(path.join(root, 'outside', 'config'), [])).toBe(true);
    } finally { release(); }
    // QQ B2: the link is still on disk after the session; it stays refused.
    expect(isPathAllowedAgainst(link, [])).toBe(false);
  });

  // QQ B3: the file is swapped for an outside link after the first check. Deciding from its real path
  // would see "not an agy folder" and read the outside file; these decide from the requested path.
  it.skipIf(!posix)('refuses a swap to an outside link between the check and the real path / open', async () => {
    const task = path.join(root, 'task3');
    mkdirSync(task);
    const pic = path.join(task, 'a.png');
    writeFileSync(pic, 'PNG');
    const release = registerAgyTaskDir(task);
    try {
      expect(agyHostPathRefusal(pic)).toBeNull();           // the entry's first check passes
      renameSync(pic, `${pic}.bak`);                          // ... then agy swaps the file
      symlinkSync(path.join(root, 'outside', 'config'), pic);
      expect(realpathSync(pic)).toBe(path.join(root, 'outside', 'config')); // what the old code went on with
      await expect(agyAwareRealpath(pic)).rejects.toThrow(/link/);
      await expect(openNoFollowForRead(pic)).rejects.toThrow(/link/);
      // Swapped after the real path was taken: opening that real path is refused too.
      rmSync(pic); renameSync(`${pic}.bak`, pic);
      const real = await agyAwareRealpath(pic);
      renameSync(pic, `${pic}.bak`);
      symlinkSync(path.join(root, 'outside', 'config'), pic);
      await expect(openNoFollowForRead(real)).rejects.toThrow(/link/);
      // Outside any agy folder: unchanged.
      await expect(agyAwareRealpath(path.join(root, 'outside', 'config'))).resolves.toBe(path.join(root, 'outside', 'config'));
      // QQ R2: what is handed to another program is the checked real path; a link out is refused.
      expect(() => agyHandoffPath(pic)).toThrow(/link/);
      symlinkSync('real.png', path.join(task, 'alias.png'));
      writeFileSync(path.join(task, 'real.png'), 'PNG');
      expect(agyHandoffPath(path.join(task, 'alias.png'))).toBe(path.join(task, 'real.png'));
      expect(agyHandoffPath(path.join(root, 'outside', 'config'))).toBe(path.join(root, 'outside', 'config'));
    } finally { release(); }
  });

  it.skipIf(!posix)('pushes the third sentence once per path for entries without a text channel', () => {
    const task = path.join(root, 'task2');
    mkdirSync(task);
    symlinkSync(path.join(root, 'outside', 'config'), path.join(task, 'pic.png'));
    const sent: { message: string; key: string }[] = [];
    setAgyHostPathRefusalNotifier(payload => sent.push(payload));
    const release = registerAgyTaskDir(task);
    try {
      expect(notifyAgyHostPathRefusal(path.join(task, 'pic.png'))).toBe(true);
      expect(notifyAgyHostPathRefusal(path.join(task, 'pic.png'))).toBe(true);
      expect(notifyAgyHostPathRefusal(path.join(root, 'outside', 'config'))).toBe(false);
      // The dangerous-attachment stage uses the same third sentence (JJ: not the link sentence).
      expect(agyNotInTaskFolderRefusal(path.join(task, 'pic.png'))).toBe(sent[0]?.message);
      expect(agyNotInTaskFolderRefusal(path.join(root, 'outside', 'config'))).toBeNull();
      expect(sent).toEqual([{ key: path.join(task, 'pic.png'),
        message: 'This file is not in the task folder, so Cindy did not open it. If you need it, copy it into the task folder and try again.' }]);
    } finally { release(); setAgyHostPathRefusalNotifier(() => {}); }
  });
});
