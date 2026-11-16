/**
 * Map an agy ACP tool call to Cindy's auto-review action shape.
 *
 * Ported from the Cursor ACP permission mapper in makecindy/cindy#5611 (Ken / kenlinjie),
 * extended with agy's PascalCase input keys. Review only concrete native input; a display
 * title is not command/path evidence.
 */
import type { ReviewableAction } from '../shared/auto-review.js';
import { record, type AcpRecord } from './models.js';

export function agyReviewAction(tool: AcpRecord, workingDir: string): ReviewableAction {
  const input = { ...record(tool.args), ...record(tool.rawInput) };
  const text = (...keys: string[]) => keys.map(key => input[key]).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const locations = Array.isArray(tool.locations) ? tool.locations.map(record) : [];
  const target = text('Path', 'AbsolutePath', 'TargetFile', 'path', 'filePath', 'file_path', 'target_file', 'targetPath', 'absolutePath')
    ?? (locations.length === 1 && typeof locations[0].path === 'string' ? locations[0].path : undefined);
  const cwdKeys = ['Cwd', 'cwd', 'workingDirectory'];
  switch (tool.kind) {
    case 'execute':
      return { kind: 'exec', command: text('CommandLine', 'command', 'cmd') ?? '',
        cwd: text(...cwdKeys) ?? workingDir,
        ...(cwdKeys.some(key => key in input) && !text(...cwdKeys) ? { cwdUnknown: true } : {}) };
    case 'read':
    case 'search':
      // Missing or multiple targets cannot be silently classified as a safe read.
      if (target && locations.length <= 1) return { kind: 'read', path: target, ...(tool.kind === 'search' ? { scope: 'tree' as const } : {}) };
      break;
    case 'edit':
      // ACP provides lexical locations, not execution-time canonical write roots.
      if (target && locations.length <= 1) return { kind: 'file-write', path: target, resolvedPath: null, resolvedWritableRoots: null };
      break;
    case 'fetch':
      return { kind: 'network', target: text('Url', 'url', 'uri', 'query'), operation: text('method') };
  }
  return { kind: 'other', description: JSON.stringify({ kind: tool.kind, name: tool.name, input, ...(locations.length ? { locations } : {}) }) };
}
