// @vitest-environment jsdom
/**
 * agy(Antigravity)历史任务的引擎图标:中性通用图标 + 「Antigravity」标注,不画 Claude 像素脸;
 * 原有三种引擎的图标不变(PG 决定,oppie-github#25 comment 6905513769)。
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { VendorIcon } from '@/components/sidebar/VendorIcon';

afterEach(() => cleanup());

describe('VendorIcon agy', () => {
  it('renders a neutral engine icon labelled Antigravity, not the Claude mark', () => {
    const agy = render(<VendorIcon vendor="agy" />);
    const cc = render(<VendorIcon vendor="cc" />);
    const agyRoot = agy.container.firstElementChild as HTMLElement;
    const ccRoot = cc.container.firstElementChild as HTMLElement;
    expect(agyRoot.getAttribute('title')).toBe('Antigravity');
    expect(agyRoot.getAttribute('aria-label')).toBe('Antigravity');
    expect(agyRoot.innerHTML).not.toBe(ccRoot.innerHTML);
    expect(agyRoot.querySelector('svg')).not.toBeNull();
  });

  it('keeps an explicit title after the Antigravity label', () => {
    const { container } = render(<VendorIcon vendor="agy" title="Studio Mac" />);
    expect((container.firstElementChild as HTMLElement).getAttribute('title')).toBe('Antigravity · Studio Mac');
  });

  it('leaves the existing three engine icons unlabelled by default', () => {
    for (const vendor of ['cc', 'codex', 'pi'] as const) {
      const { container } = render(<VendorIcon vendor={vendor} />);
      const root = container.firstElementChild as HTMLElement;
      expect(root.getAttribute('title')).toBeNull();
      expect(root.getAttribute('aria-label')).toBeNull();
      cleanup();
    }
  });
});
