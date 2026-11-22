/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  forgetAgySwitchPermissionAgreed, noteAgySwitchPermissionAgreed, readAgySwitchPermissionAgreed,
  type AgySwitchPermissionPendingIntent,
} from '@/components/new-chat/agentSwitchConfirmation';
import { AgySwitchPermissionPendingNotice } from '@/components/chat/AgySwitchPermissionPendingNotice';
import { useAgySwitchPermissionRecovery } from '@/components/new-chat/useAgySwitchPermissionRecovery';

const h = vi.hoisted(() => ({
  intent: null as null | { target: string; model: string; providerId: string | null },
  registerWithHost: vi.fn(async (..._args: unknown[]) => ({})),
  toastError: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { getAgentSwitchIntent: () => h.intent } }));
vi.mock('@/lib/makerTransport', () => ({ makerApiFor: () => ({ switchSessionAgent: h.registerWithHost }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: h.toastError } }));

// cindy#19 (QQ's ruling after DD 7077886823): the host holds a message when applying the pending
// switch into Antigravity would rewrite the task's permissions without the user's agreement (the
// mode was changed from another window, a device or IM). The task view used to show only a generic
// error. It must ask, once; send nothing if declined; and resend the held message once if agreed.
// DD 7079095110: a resend clears the error before the host answers, so a second refusal used to
// count as a new occasion and was resent without asking, with no limit.
// Component tier: the real hook, gate and dialog; the store and the host call are stand-ins.
const HELD = 'AGENT_SWITCH_PERMISSION_UNCONFIRMED: not confirmed';
const TITLE = 'newChat.chatInput.agentSwitch.sendConfirmation.titleFromFullAccess';
const CONFIRM = 'newChat.chatInput.agentSwitch.sendConfirmation.confirm';
const DECLINE = 'newChat.chatInput.agentSwitch.sendConfirmation.cancel';

type ViewProps = { error: string | null; mode: string; onResend: () => void; remote?: boolean };
function TaskView({ error, mode, onResend, remote = false }: ViewProps) {
  const { confirm } = useConfirmDialog();
  const retry = useAgySwitchPermissionRecovery({
    sessionId: 'task-1', error, runningAgent: 'claude-code', permissionMode: mode, remote, confirm, retry: onResend,
  });
  return <button type="button" onClick={retry}>Retry</button>;
}
const view = (props: ViewProps) => <ConfirmDialogProvider><TaskView {...props} /></ConfirmDialogProvider>;
const settle = () => act(async () => { await Promise.resolve(); });

describe('a message the host held for an unconfirmed permission change', () => {
  beforeEach(() => {
    h.intent = { target: 'agy', model: 'gemini-test', providerId: null };
    h.registerWithHost.mockClear();
    h.toastError.mockClear();
    forgetAgySwitchPermissionAgreed('task-1');
    noteAgySwitchPermissionAgreed('task-1', 'ask');
  });
  afterEach(() => { cleanup(); });

  it('asks once; declining resends nothing and does not ask again until the user retries', async () => {
    const onResend = vi.fn();
    const shown = render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: DECLINE }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    shown.rerender(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    await settle();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(onResend).not.toHaveBeenCalled();
    expect(h.registerWithHost).not.toHaveBeenCalled();

    // The banner's Retry asks again instead of resending a message the host would hold again.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(onResend).not.toHaveBeenCalled();
  });

  // The whole path a user takes after "not now" (agreed with QQ after DD 7079095110): nothing is
  // sent, the banner's action asks again, and agreeing there sends the same message exactly once.
  it('after "not now", confirming from the banner records the agreement once and resends the message exactly once', async () => {
    h.registerWithHost.mockResolvedValue({ agyPermissionAgreementRecorded: true });
    const onResend = vi.fn();
    const shown = render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: DECLINE }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    expect(onResend).not.toHaveBeenCalled();
    expect(h.registerWithHost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(h.registerWithHost).toHaveBeenCalledTimes(1);
    // The resend clears the error; whatever is reported afterwards, nothing more goes out.
    shown.rerender(view({ error: null, mode: 'bypassPermissions', onResend }));
    await settle();
    shown.rerender(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    await settle();
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(h.registerWithHost).toHaveBeenCalledTimes(1);
  });

  it('on agreement tells the host what was agreed, then resends the held message once', async () => {
    const onResend = vi.fn();
    const shown = render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(h.registerWithHost).toHaveBeenCalledExactlyOnceWith(
      'task-1', 'agy', 'gemini-test', null, undefined, undefined,
      { agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementOnly: true },
    );
    // The same held message reported again (the host refused once more) must not start a loop.
    shown.rerender(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    await settle();
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it('stops after one resend when the error is cleared and the host holds the message again', async () => {
    const onResend = vi.fn();
    const shown = render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    // What a resend really looks like: the error goes away, then the host refuses again. Twice over.
    for (let round = 0; round < 2; round += 1) {
      shown.rerender(view({ error: null, mode: 'bypassPermissions', onResend }));
      await settle();
      shown.rerender(view({ error: HELD, mode: 'bypassPermissions', onResend }));
      await settle();
    }
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(h.registerWithHost).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(TITLE)).toBeNull();

    // The banner's action asks again: the agreement remembered here is one the host does not have.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(onResend).toHaveBeenCalledTimes(1);
  });

  it('asks again for a later pending switch of the same task', async () => {
    const onResend = vi.fn();
    const shown = render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: DECLINE }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    // The switch was withdrawn, then picked again from somewhere that gave no agreement.
    h.intent = null;
    shown.rerender(view({ error: null, mode: 'bypassPermissions', onResend }));
    await settle();
    h.intent = { target: 'agy', model: 'gemini-test', providerId: null };
    shown.rerender(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(onResend).not.toHaveBeenCalled();
  });

  it('resends once without asking when the user has since agreed in the permission menu', async () => {
    const onResend = vi.fn();
    const shown = render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: DECLINE }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    // The permission menu's own dialog recorded the agreement and stored another mode.
    noteAgySwitchPermissionAgreed('task-1', 'acceptEdits');
    shown.rerender(view({ error: HELD, mode: 'acceptEdits', onResend }));
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: CONFIRM })).toBeNull();
  });

  it('asks nothing on a computer that controls the task remotely, where the host takes no agreement', async () => {
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend, remote: true }));
    await settle();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(onResend).not.toHaveBeenCalled();
    // Its Retry is the ordinary one: confirming on the task's computer may have happened since.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(h.registerWithHost).not.toHaveBeenCalled();
  });

  it('leaves other errors to the ordinary retry and does not ask about them', async () => {
    const onResend = vi.fn();
    render(view({ error: 'SEND_FAILED: boom', mode: 'bypassPermissions', onResend }));
    await settle();
    expect(screen.queryByText(TITLE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(h.registerWithHost).not.toHaveBeenCalled();
  });

  it('says so and does not resend when the host could not record the agreement', async () => {
    h.registerWithHost.mockRejectedValueOnce(new Error('offline'));
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledExactlyOnceWith('newChat.chatInput.agentSwitch.failed'));
    expect(onResend).not.toHaveBeenCalled();
  });

  it('does not resend when the host answers that the switch asked about is no longer the pending one', async () => {
    h.registerWithHost.mockResolvedValueOnce({ agyPermissionAgreementRecorded: false });
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledTimes(1));
    await settle();
    expect(onResend).not.toHaveBeenCalled();
    expect(readAgySwitchPermissionAgreed('task-1')).toBeUndefined();
  });
});

// QQ's ruling on the desktop entry: someone whose IM message was refused is told to confirm in
// the task. The host kept no message, so the task's entry agrees to the permission change of the
// pending switch and sends nothing; its wording must not promise a send, declining must leave the
// entry in place, and it shows for as long as the host has no agreement that fits the stored mode.
// Component tier: the real notice, gate and dialog; the host call is a stand-in (its side is in
// agySwitchPermissionEntry.test.ts).
describe('the task\'s entry to confirm a pending switch\'s permission change', () => {
  const NOTICE = 'newChat.chatInput.agentSwitch.permissionEntry.notice';
  const REVIEW = 'chat.errorBanner.agentSwitchPermissionReview';
  const ENTRY_TITLE = 'newChat.chatInput.agentSwitch.permissionEntry.titleFromFullAccess';
  const AGREE = 'newChat.chatInput.agentSwitch.permissionConfirmation.confirm';
  const NOT_NOW = 'newChat.chatInput.agentSwitch.permissionConfirmation.cancel';
  const waiting: AgySwitchPermissionPendingIntent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionAgreement: null };
  type EntryProps = { intent: AgySwitchPermissionPendingIntent | null; mode: string; partner?: boolean };
  function Entry({ intent, mode, partner = false }: EntryProps) {
    const { confirm } = useConfirmDialog();
    return <AgySwitchPermissionPendingNotice sessionId="task-1" intent={intent} runningAgent="claude-code"
      permissionMode={mode} partnerConversation={partner} confirm={confirm} />;
  }
  const entry = (props: EntryProps) => <ConfirmDialogProvider><Entry {...props} /></ConfirmDialogProvider>;

  beforeEach(() => {
    h.registerWithHost.mockClear();
    h.registerWithHost.mockResolvedValue({ agyPermissionAgreementRecorded: true });
    h.toastError.mockClear();
    forgetAgySwitchPermissionAgreed('task-1');
  });
  afterEach(() => { cleanup(); });

  it.each<[string, EntryProps, boolean]>([
    ['nothing is agreed and the mode would be rewritten', { intent: waiting, mode: 'bypassPermissions' }, true],
    ['what is agreed is for another mode', { intent: { ...waiting, agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' } }, mode: 'acceptEdits' }, true],
    ['the host has the agreement for this mode', { intent: { ...waiting, agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' } }, mode: 'bypassPermissions' }, false],
    ['Antigravity keeps the mode', { intent: waiting, mode: 'ask' }, false],
    ['the host did not report what is agreed', { intent: { target: 'agy', model: 'gemini-test', providerId: null }, mode: 'bypassPermissions' }, false],
    ['a partner conversation follows the partner\'s settings', { intent: { ...waiting, configStaged: true }, mode: 'bypassPermissions', partner: true }, false],
    ['the user picked the model in a partner conversation', { intent: waiting, mode: 'bypassPermissions', partner: true }, true],
    ['no switch is pending', { intent: null, mode: 'bypassPermissions' }, false],
  ])('when %s', (_name, props, shown) => {
    render(entry(props));
    expect(screen.queryByText(NOTICE) !== null).toBe(shown);
  });

  it('asks even if this window remembers an answer, records it with the host, and sends nothing', async () => {
    noteAgySwitchPermissionAgreed('task-1', 'bypassPermissions');
    render(entry({ intent: waiting, mode: 'bypassPermissions' }));
    fireEvent.click(screen.getByRole('button', { name: REVIEW }));
    expect(await screen.findByText(ENTRY_TITLE)).toBeTruthy();
    // Says what confirming does not do, and offers no button that promises a send.
    expect(screen.getByText(/newChat\.chatInput\.agentSwitch\.permissionEntry\.note/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: CONFIRM })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: NOT_NOW }));
    await waitFor(() => expect(screen.queryByText(ENTRY_TITLE)).toBeNull());
    expect(h.registerWithHost).not.toHaveBeenCalled();
    expect(screen.getByText(NOTICE)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: REVIEW }));
    fireEvent.click(await screen.findByRole('button', { name: AGREE }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledExactlyOnceWith(
      'task-1', 'agy', 'gemini-test', null, undefined, undefined,
      { agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementOnly: true },
    ));
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('answers only for the switch it showed when another one is pending by the time of the answer', async () => {
    const shown = render(entry({ intent: waiting, mode: 'bypassPermissions' }));
    fireEvent.click(screen.getByRole('button', { name: REVIEW }));
    await screen.findByText(ENTRY_TITLE);
    // Another Gemini model is picked elsewhere while the dialog is open; the host will say so.
    h.registerWithHost.mockResolvedValueOnce({ agyPermissionAgreementRecorded: false });
    shown.rerender(entry({ intent: { ...waiting, model: 'gemini-other' }, mode: 'bypassPermissions' }));
    fireEvent.click(screen.getByRole('button', { name: AGREE }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledTimes(1));
    expect(h.registerWithHost.mock.calls[0]![2]).toBe('gemini-test');
    await settle();
    expect(readAgySwitchPermissionAgreed('task-1')).toBeUndefined();
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });
});
