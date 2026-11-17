/**
 * Protocol entries (xdt-file / xdt-audio) have no text channel; the host pushes the refusal and the
 * renderer shows JJ's sentence once per path (cindy#15).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const warning = vi.fn();
vi.mock('../toast', () => ({ toast: { warning: (...args: unknown[]) => warning(...args) } }));

import { handleAgyHostPathRefused } from '../agyHostPathRefusalToast';

describe('agy host path refusal toast', () => {
  beforeEach(() => { warning.mockClear(); vi.useFakeTimers(); vi.setSystemTime(1_000_000); });

  it('shows the sentence once per path, again after the quiet period', () => {
    handleAgyHostPathRefused({ message: 'SENTENCE', key: '/task/a.png' });
    handleAgyHostPathRefused({ message: 'SENTENCE', key: '/task/a.png' });
    handleAgyHostPathRefused({ message: 'SENTENCE', key: '/task/b.png' });
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith('SENTENCE');
    vi.setSystemTime(1_000_000 + 60_001);
    handleAgyHostPathRefused({ message: 'SENTENCE', key: '/task/a.png' });
    expect(warning).toHaveBeenCalledTimes(3);
  });

  it('ignores malformed payloads', () => {
    handleAgyHostPathRefused({ message: '', key: 'x' });
    handleAgyHostPathRefused(undefined as never);
    expect(warning).not.toHaveBeenCalled();
  });
});
