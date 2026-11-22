// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY,
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

/** The composer's send button while a switch is pending: the message goes out only when the gate resolves true. */
function SendHarness({ mode, intentTarget = 'agy', runningAgent = 'claude-code', onSent }: {
  mode: string; intentTarget?: string | null; runningAgent?: string; onSent: () => void;
}) {
  const { confirm } = useConfirmDialog();
  return (
    <button
      type="button"
      onClick={() => {
        void confirmPendingAgySwitchPermission({
          sessionId: 'task-1', intentTarget, runningAgent, permissionMode: mode, confirm, copy: COPY, t: key => key,
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

  // cindy#19, DD review 7077385323 item 5: the switch is applied by the next send, and the
  // permission menu stays usable in between. The dialog was shown once, when the Gemini model was
  // picked, so a mode changed afterwards was rewritten at send time with no notice, or with a
  // notice that named a different outcome. The send must restate the actual change and wait.
  const FROM_FULL_ACCESS = 'newChat.chatInput.agentSwitch.confirmation.antigravityFromFullAccess';
  const FROM_UNSUPPORTED = 'newChat.chatInput.agentSwitch.confirmation.antigravityFromUnsupported';
  it.each([
    ['agreed while in Default permissions, then picked Full access', 'ask', 'bypassPermissions', FROM_FULL_ACCESS],
    ['agreed to leave Full access, then picked Accept edits', 'bypassPermissions', 'acceptEdits', FROM_UNSUPPORTED],
    ['agreed to leave Accept edits, then picked Full access', 'acceptEdits', 'bypassPermissions', FROM_FULL_ACCESS],
  ])('a send restates the permission change and waits: %s', async (_name, agreedIn, modeAtSend, notice) => {
    forgetAgySwitchPermissionAgreed('task-1');
    noteAgySwitchPermissionAgreed('task-1', agreedIn);
    const onSent = vi.fn();
    renderSend({ mode: modeAtSend, onSent });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByText(new RegExp(notice.replace(/\./g, '\\.')))).textContent).toContain(COPY.description);
    expect(screen.queryByRole('checkbox', { name: COPY.dontShowAgainLabel })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: COPY.cancelText }));
    await waitFor(() => expect(screen.queryByText(COPY.title)).toBeNull());
    expect(onSent).not.toHaveBeenCalled();

    // Cancelling agreed to nothing: the next send asks again, and agreeing lets later sends through.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: COPY.confirmText }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });

  it.each([
    ['the outcome is the one agreed to', 'acceptEdits', 'plan', 'agy', 'claude-code'],
    ['the user picked a mode Antigravity keeps', 'bypassPermissions', 'ask', 'agy', 'claude-code'],
    ['the mode is unchanged since agreeing', 'bypassPermissions', 'bypassPermissions', 'agy', 'claude-code'],
    ['the pending switch targets another engine', 'ask', 'bypassPermissions', 'codex', 'claude-code'],
    ['the task already runs Antigravity', 'ask', 'bypassPermissions', 'agy', 'agy'],
    ['no switch is pending', 'ask', 'bypassPermissions', null, 'claude-code'],
  ])('a send goes straight out when %s', async (_name, agreedIn, modeAtSend, intentTarget, runningAgent) => {
    forgetAgySwitchPermissionAgreed('task-1');
    noteAgySwitchPermissionAgreed('task-1', agreedIn);
    const onSent = vi.fn();
    renderSend({ mode: modeAtSend, intentTarget, runningAgent, onSent });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });

  it('asks before sending when nothing was agreed for this pending switch', async () => {
    noteAgySwitchPermissionAgreed('task-1', 'bypassPermissions');
    forgetAgySwitchPermissionAgreed('task-1');
    const onSent = vi.fn();
    renderSend({ mode: 'bypassPermissions', onSent });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(new RegExp(FROM_FULL_ACCESS.replace(/\./g, '\\.')));
    expect(onSent).not.toHaveBeenCalled();
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
