/**
 * chat-attachment:stage tells the user why an agy task-folder link was refused (JJ on cindy#15).
 */
import { describe, expect, it, vi } from 'vitest';

import { createChatAttachmentStageHandler, type ChatAttachmentStageDeps } from '../chatAttachmentStage';

describe('chat-attachment:stage and agy task folders', () => {
  const deps = (agyRefusal: (p: string) => string | null): ChatAttachmentStageDeps & { agyRefusal: (p: string) => string | null } => ({
    isPathAllowed: vi.fn(() => true),
    realpath: vi.fn(async (p: string) => p),
    stat: vi.fn(async () => ({ dev: 1n, ino: 1n, size: 1n, isFile: () => true })),
    openSource: vi.fn(async () => { throw new Error('must not open'); }),
    stageCopy: vi.fn(async () => 'never'),
    agyRefusal,
  });

  it('returns the sentence as message, before following the path', async () => {
    const d = deps(p => (p.endsWith('link.exe') ? 'SENTENCE' : null));
    const result = await createChatAttachmentStageHandler(d)({ sourcePath: '/task/link.exe', suggestedName: 'link.exe' });
    expect(result).toEqual({ success: false, code: 'forbidden', message: 'SENTENCE' });
    expect(d.realpath).not.toHaveBeenCalled();
    expect(d.openSource).not.toHaveBeenCalled();
  });
});
