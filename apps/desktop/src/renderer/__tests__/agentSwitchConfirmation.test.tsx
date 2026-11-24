// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY,
  agyPermissionChangeTitle,
  agySwitchPermissionNotice,
  confirmAgentSwitchRisk,
  confirmPendingAgySwitchPermission,
  forgetAgySwitchPermissionAgreed,
  noteAgySwitchPermissionAgreed,
  relocationDescriptionKey,
} from '@/components/new-chat/agentSwitchConfirmation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const STORAGE_KEY = `confirm-dialog.skip:${AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY}`;
const COPY = {
  title: 'Switch Agent?',
  description: 'Switching agents has handoff costs.',
  confirmText: 'Switch Agent',
  cancelText: 'Keep Current Agent',
  dontShowAgainLabel: 'Don’t remind me again',
};

function Harness({
  hasSwitchIntent = false,
  permissionNotice,
  onBrowse,
}: {
  hasSwitchIntent?: boolean;
  permissionNotice?: string;
  onBrowse: () => void;
}) {
  const { confirm } = useConfirmDialog();
  return (
    <button
      type="button"
      onClick={() => {
        void confirmAgentSwitchRisk({
          hasSwitchIntent,
          confirm,
          copy: COPY,
          permissionNotice,
        }).then((proceed) => {
          if (proceed) onBrowse();
        });
      }}
    >
      Browse Target Agent
    </button>
  );
}

const GATE_COPY = {
  title: { fromFullAccess: 'Send with Auto-review?', fromUnsupported: 'Send with Default permissions?' },
  confirmText: 'Confirm and send',
  cancelText: 'Don’t send yet',
};

/** The composer while a switch is pending: the send, or the permission change, goes on only when the gate resolves true. */
function SendHarness({ mode, intentTarget = 'agy', runningAgent = 'claude-code', onSent, statement }: {
  mode: string; intentTarget?: string | null; runningAgent?: string; onSent: () => void;
  statement?: { fromUnsupported?: string };
}) {
  const { confirm } = useConfirmDialog();
  return (
    <button
      type="button"
      onClick={() => {
        void confirmPendingAgySwitchPermission({
          sessionId: 'task-1', intentTarget, runningAgent, permissionMode: mode, confirm,
          copy: statement ? { ...GATE_COPY, statement } : GATE_COPY, t: key => key,
        }).then((send) => {
          if (send) onSent();
        });
      }}
    >
      Send
    </button>
  );
}

function renderSend(props: Parameters<typeof SendHarness>[0]) {
  return render(
    <ConfirmDialogProvider>
      <SendHarness {...props} />
    </ConfirmDialogProvider>,
  );
}

function renderHarness(props: Parameters<typeof Harness>[0]) {
  return render(
    <ConfirmDialogProvider>
      <Harness {...props} />
    </ConfirmDialogProvider>,
  );
}

describe('Agent switch confirmation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  // JJ 7081611824, on QQ's ruling: the permission menu asks before the picked mode is stored, so
  // the shared body's "the level you use now" named a level the user was leaving. That dialog has
  // its own body for a mode Antigravity does not have; the body about leaving Full access, and
  // every other place that asks, keep the shared one.
  it.each([
    ['a mode Antigravity does not have', 'acceptEdits', 'the level you just picked', 'antigravityFromUnsupported'],
    ['Full access', 'bypassPermissions', 'antigravityFromFullAccess', 'the level you just picked'],
  ])('the dialog of the permission menu states the change in its own words for %s only', async (_name, mode, shown, absent) => {
    forgetAgySwitchPermissionAgreed('task-1');
    renderSend({ mode, onSent: vi.fn(), statement: { fromUnsupported: 'the level you just picked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(new RegExp(shown))).toBeTruthy();
    expect(screen.queryByText(new RegExp(absent))).toBeNull();
  });

  it('prompts before browsing another Agent and cancel leaves the tab untouched', async () => {
    const onBrowse = vi.fn();
    renderHarness({ onBrowse });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    const title = await screen.findByText(COPY.title);
    expect(title.className).toContain('select-none');
    expect(screen.getByText(COPY.description).className).toContain('select-none');

    fireEvent.click(screen.getByRole('checkbox', { name: COPY.dontShowAgainLabel }));
    fireEvent.click(screen.getByRole('button', { name: COPY.cancelText }));
    await waitFor(() => expect(screen.queryByText(COPY.title)).toBeNull());
    expect(onBrowse).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // cindy#19: the switch into Antigravity can change the task's permissions. "Don't remind me
  // again" was saved for the handoff risk only, so it must not hide that change or offer to.
  it('announces a permission change even after the handoff reminder was turned off', async () => {
    localStorage.setItem(STORAGE_KEY, '1');
    const onBrowse = vi.fn();
    renderHarness({ onBrowse, permissionNotice: 'Permissions change to Auto-review.' });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    expect((await screen.findByText(/Permissions change to Auto-review/)).textContent).toContain(COPY.description);
    expect(screen.queryByRole('checkbox', { name: COPY.dontShowAgainLabel })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: COPY.cancelText }));
    await waitFor(() => expect(screen.queryByText(COPY.title)).toBeNull());
    expect(onBrowse).not.toHaveBeenCalled();
  });

  // cindy#19 (QQ 7076801733): the notice must name the mode the row commit actually saves. Full
  // access and a mode Antigravity lacks land on different modes, so they get different copy; a kept
  // mode, or a task that is already Antigravity, gets none.
  it.each([
    ['bypassPermissions', 'claude-code', 'newChat.chatInput.agentSwitch.confirmation.antigravityFromFullAccess'],
    ['acceptEdits', 'claude-code', 'newChat.chatInput.agentSwitch.confirmation.antigravityFromUnsupported'],
    ['plan', 'codex', 'newChat.chatInput.agentSwitch.confirmation.antigravityFromUnsupported'],
    ['auto', 'claude-code', undefined],
    ['ask', 'pi', undefined],
    ['bypassPermissions', 'agy', undefined],
  ])('picks the Antigravity permission notice for a task in %s running %s', (mode, running, key) => {
    expect(agySwitchPermissionNotice('agy', running, mode, k => k).permissionNotice).toBe(key);
    expect(agySwitchPermissionNotice('codex', running, mode, k => k).permissionNotice).toBeUndefined();
  });

  it('confirming a switch that changes permissions proceeds', async () => {
    const onBrowse = vi.fn();
    renderHarness({ onBrowse, permissionNotice: 'Permissions change to Default permissions.' });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    await screen.findByText(/Permissions change to Default permissions/);
    fireEvent.click(screen.getByRole('button', { name: COPY.confirmText }));
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // cindy#19, DD reviews 7077385323 item 5 and 7077886823. The switch is applied by a later send
  // (the composer's, or a queued or IM message the host dispatches), and the permission menu stays
  // usable in between. The dialog was shown once, when the Gemini model was picked, so a mode
  // changed afterwards was rewritten with no notice, or with a notice that named another outcome.
  // The same gate runs when the mode is changed and before a send; these drive it as each does.
  const FROM_FULL_ACCESS = 'newChat.chatInput.agentSwitch.confirmation.antigravityFromFullAccess';
  const FROM_UNSUPPORTED = 'newChat.chatInput.agentSwitch.confirmation.antigravityFromUnsupported';
  const FULL_ACCESS_CASE = [FROM_FULL_ACCESS, GATE_COPY.title.fromFullAccess] as const;
  const UNSUPPORTED_CASE = [FROM_UNSUPPORTED, GATE_COPY.title.fromUnsupported] as const;
  it.each([
    ['agreed while in Default permissions, then Full access', 'ask', 'bypassPermissions', ...FULL_ACCESS_CASE],
    ['agreed to leave Full access, then Accept edits', 'bypassPermissions', 'acceptEdits', ...UNSUPPORTED_CASE],
    ['agreed to leave Accept edits, then Full access', 'acceptEdits', 'bypassPermissions', ...FULL_ACCESS_CASE],
    // Same resulting mode as what was agreed, but that agreement announced no rewrite at all.
    ['agreed while in Auto-review, then Full access', 'auto', 'bypassPermissions', ...FULL_ACCESS_CASE],
    ['agreed while in Default permissions, then Accept edits', 'ask', 'acceptEdits', ...UNSUPPORTED_CASE],
  ])('restates the permission change and waits: %s', async (_name, agreedIn, modeNow, notice, title) => {
    forgetAgySwitchPermissionAgreed('task-1');
    noteAgySwitchPermissionAgreed('task-1', agreedIn);
    const onSent = vi.fn();
    renderSend({ mode: modeNow, onSent });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByText(notice)).toBeTruthy();
    expect(screen.queryByText(COPY.title)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: GATE_COPY.cancelText }));
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
    expect(onSent).not.toHaveBeenCalled();

    // Declining agreed to nothing: the next attempt asks again, and agreeing lets later ones through.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: GATE_COPY.confirmText }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(title)).toBeNull();
  });

  it.each([
    ['the rewrite is the one agreed to', 'acceptEdits', 'plan', 'agy', 'claude-code'],
    ['the user picked a mode Antigravity keeps', 'bypassPermissions', 'ask', 'agy', 'claude-code'],
    ['the mode is unchanged since agreeing', 'bypassPermissions', 'bypassPermissions', 'agy', 'claude-code'],
    ['the pending switch targets another engine', 'ask', 'bypassPermissions', 'codex', 'claude-code'],
    ['the task already runs Antigravity', 'ask', 'bypassPermissions', 'agy', 'agy'],
    ['no switch is pending', 'ask', 'bypassPermissions', null, 'claude-code'],
  ])('goes straight through when %s', async (_name, agreedIn, modeNow, intentTarget, runningAgent) => {
    forgetAgySwitchPermissionAgreed('task-1');
    noteAgySwitchPermissionAgreed('task-1', agreedIn);
    const onSent = vi.fn();
    renderSend({ mode: modeNow, intentTarget, runningAgent, onSent });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: GATE_COPY.confirmText })).toBeNull();
  });

  it('asks when nothing was agreed for this pending switch', async () => {
    noteAgySwitchPermissionAgreed('task-1', 'bypassPermissions');
    forgetAgySwitchPermissionAgreed('task-1');
    const onSent = vi.fn();
    renderSend({ mode: 'bypassPermissions', onSent });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(GATE_COPY.title.fromFullAccess)).toBeTruthy();
    expect(onSent).not.toHaveBeenCalled();
  });

  // JJ 7078293935 §3: the dialog shown when a mode is picked in the menu names that mode, as the
  // menu labelled it. The earlier fixed title for a mode Antigravity lacks ("this permission level")
  // did not say which one, and the mode after the switch (Default permissions) is not what was picked.
  it.each(['zh-CN', 'en', 'zh-TW'] as const)('titles the permission-change dialog with the mode just picked (%s)', (language) => {
    const strings = JSON.parse(readFileSync(resolve(__dirname, `../i18n/locales/${language}/common.json`), 'utf8'))
      .newChat as { permissionSelector: { modes: Record<string, Record<string, { label: string }>> };
      chatInput: { agentSwitch: { permissionConfirmation: { title: string } } } };
    const t = (key: string, options?: Record<string, unknown>) => {
      const value = key.replace(/^newChat\./, '').split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], strings);
      const text = typeof value === 'string' ? value : String(options?.defaultValue ?? key);
      return text.replace('{{mode}}', String(options?.mode ?? ''));
    };
    const labels = strings.permissionSelector.modes['claude-code'];
    const title = strings.chatInput.agentSwitch.permissionConfirmation.title;
    expect(agyPermissionChangeTitle(t, 'claude-code', 'acceptEdits')).toBe(title.replace('{{mode}}', labels.acceptEdits.label));
    expect(agyPermissionChangeTitle(t, 'claude-code', 'bypassPermissions')).toBe(title.replace('{{mode}}', labels.bypassPermissions.label));
    expect(agyPermissionChangeTitle(t, 'claude-code', 'acceptEdits')).not.toContain(labels.ask.label);
    // A mode with no label of its own in this build still names itself rather than a wrong one.
    expect(agyPermissionChangeTitle(t, 'codex', 'plan', 'Plan')).toBe(title.replace('{{mode}}', 'Plan'));
  });

  it('does not prompt again when an Agent switch intent already exists', async () => {
    const onBrowse = vi.fn();
    renderHarness({ hasSwitchIntent: true, onBrowse });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });

  it('persists the explicit skip override only after checked confirmation', async () => {
    const onBrowse = vi.fn();
    const first = renderHarness({ onBrowse });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: COPY.dontShowAgainLabel }));
    fireEvent.click(screen.getByRole('button', { name: COPY.confirmText }));
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');

    first.unmount();
    renderHarness({ onBrowse });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    });
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });
});

// #7573 后同引擎换电脑会复制完整原生记录;跨引擎、分享来源仍只能走摘要,文案不能说成记录已带过去。
// ChatInput 体量过大无法在 unit 里挂载;判定与文案 key 收在此函数,这里连同真实 locale 文本一起断言。
describe('relocationDescriptionKey', () => {
  const base = {
    fromAgent: 'claude-code',
    toAgent: 'claude-code',
    fromAgentDeviceId: null,
    toAgentDeviceId: 'mini',
  };
  const locale = (name: string) =>
    JSON.parse(readFileSync(resolve(__dirname, `../i18n/locales/${name}/common.json`), 'utf8'))
      .newChat.chatInput.agentRelocation;
  const NATIVE = 'newChat.chatInput.agentRelocation.descriptionNativeHistory';
  const SUMMARY = 'newChat.chatInput.agentRelocation.description';

  it.each([
    ['same engine between own computers', {}, NATIVE],
    ['back to this computer', { fromAgentDeviceId: 'mini', toAgentDeviceId: null }, NATIVE],
    ['different engine', { toAgent: 'codex' }, SUMMARY],
    ['shared target', { toAgentDeviceId: 'share:abc' }, SUMMARY],
    ['shared source', { fromAgentDeviceId: 'share:abc' }, SUMMARY],
  ])('%s', (_name, override, expected) => {
    expect(relocationDescriptionKey({ ...base, ...override })).toBe(expected);
  });

  it('keys resolve to the native-history and summary-only copy', () => {
    expect(locale('zh-CN').descriptionNativeHistory).toContain('完整对话记录会复制过去');
    expect(locale('zh-CN').description).toContain('带不过来');
  });
});
