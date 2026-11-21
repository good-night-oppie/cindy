import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const arch = process.argv[2] ?? process.arch;
  const target = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[arch];
  if (!target) throw new Error('Unsupported Windows helper architecture: ' + arch);
  const source = path.dirname(fileURLToPath(import.meta.url));
  const build = path.join(source, 'target');
  const result = spawnSync('cargo', ['build', '--release', '--locked', '--target', target,
    '--manifest-path', path.join(source, 'Cargo.toml'), '--target-dir', build], { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Could not build the Antigravity Windows helper', { cause: result.error });
  const dest = path.resolve(source, '../../resources/tools/agy');
  mkdirSync(dest, { recursive: true });
  copyFileSync(path.join(build, target, 'release', 'cindy-agy-job.exe'), path.join(dest, 'cindy-agy-job.exe'));
}
