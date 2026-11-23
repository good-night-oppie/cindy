/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  agreeToPendingAgySwitchPermission, agySwitchPendingKey, agySwitchPermissionEntryIsOffered,
  forgetAgySwitchPermissionAgreed, noteAgySwitchPermissionAgreed, readAgySwitchPermissionAgreed,
  type AgySwitchPermissionPendingIntent,
} from '@/components/new-chat/agentSwitchConfirmation';
import { AgySwitchPermissionPendingNotice } from '@/components/chat/AgySwitchPermissionPendingNotice';
import { useAgySwitchPermissionRecovery } from '@/components/new-chat/useAgySwitchPermissionRecovery';
import { agySwitchAgreementPurposeOfComposerDialog, recordAgySwitchPermissionAgreementWithHost } from '@/components/new-chat/agySwitchPermissionHost';

const h = vi.hoisted(() => ({
  intent: null as null | {
    target: string; model: string; providerId: string | null; agyPermissionRevision?: number;
    agyPermissionAgreement?: { change: 'fromFullAccess' | 'fromUnsupported' | null; mode: string } | null; agyPermissionAgreementForSend?: true;
  },
  registerWithHost: vi.fn(async (..._args: unknown[]) => ({})),
  /** Stands for what the host reports as agreed; part of what the view renders of the switch. */
  hostAgreed: '',
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
    pendingSwitchKey: h.intent ? `${h.intent.target}|${h.intent.agyPermissionRevision ?? ''}|${h.hostAgreed}` : null,
  });
  return <button type="button" onClick={retry}>Retry</button>;
}
const view = (props: ViewProps) => <ConfirmDialogProvider><TaskView {...props} /></ConfirmDialogProvider>;
const settle = () => act(async () => { await Promise.resolve(); });

// DD 7085158660, item 5. This window remembered an answer about another mode (the user had
// since changed the mode and agreed to that in another window, which the host has on record).
// Sending here asked nothing, rightly, and then told the host this window's old answer, which
// replaced the correct record: the send was refused and the user asked again.
describe('what a window tells the host when the host already has the right agreement', () => {
  const copy = { title: { fromFullAccess: 'a', fromUnsupported: 'b' }, confirmText: 'c', cancelText: 'd' };
  it('tells the host its own record for this change, never an older answer this window remembers', async () => {
    forgetAgySwitchPermissionAgreed('task-1');
    noteAgySwitchPermissionAgreed('task-1', 'plan');
    expect(readAgySwitchPermissionAgreed('task-1')).toEqual({ change: 'fromUnsupported', mode: 'ask' });
    const confirm = vi.fn(async () => true);
    const registerWithHost = vi.fn(async () => ({ agyPermissionAgreementRecorded: true }));
    const intent: AgySwitchPermissionPendingIntent = {
      target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 7,
      agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' },
    };
    await expect(agreeToPendingAgySwitchPermission({
      sessionId: 'task-1', intent, runningAgent: 'claude-code', permissionMode: 'bypassPermissions',
      confirm, copy, t: ((key: string) => key) as never, registerWithHost,
    })).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(registerWithHost.mock.calls.map((call) => (call as unknown[])[1])).toEqual([{ change: 'fromFullAccess', mode: 'auto' }]);
  });

  // QQ's ruling "A": of everything that records an agreement, only a real send, the banner of a
  // held message and the model picker may ask the host to let a held message go. The permission
  // menu's "Confirm change" is none of them. What each composer dialog asks for, and what then
  // reaches the host, through the function every caller uses.
  it.each([
    ['sendConfirmation', false],
    ['permissionConfirmation', false],
  ] as const)('the composer dialog %s asks the host to let a held message go: %s', async (about, wakes) => {
    h.registerWithHost.mockClear();
    await recordAgySwitchPermissionAgreementWithHost('task-1',
      { model: 'gemini-test', providerId: null, agyPermissionRevision: 7 },
      { change: 'fromFullAccess', mode: 'auto' }, agySwitchAgreementPurposeOfComposerDialog(about));
    const sent = h.registerWithHost.mock.calls[0]![6] as Record<string, unknown>;
    expect(sent).toMatchObject({ agyPermissionAgreementOnly: true, agyPermissionRevision: 7 });
    expect('agyPermissionAgreementForSend' in sent).toBe(wakes);
  });

  // QQ, 2026-11-22: both purposes are valid arguments, so the type checker cannot show that the
  // composer picks the right one at each of its two entries. The composer's own code, run from
  // source (as botPermissionSwitch.test.ts runs its permission callback): the function behind
  // both dialogs and the two references the send path and the permission menu call. Everything
  // below it is real: the dialog decision, the request builder, the purpose; the dialog is
  // answered "yes" and the host is the stand-in that receives the request.
  it("composer: neither the dialog of a new message's send nor the permission menu's Confirm change asks the host to let a held message go", async () => {
    const source = readFileSync(resolve(__dirname, '../components/new-chat/ChatInput.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const from = source.indexOf('  const confirmAgySwitchPermissionWhilePending = async (');
    const to = source.indexOf("  const pendingAgySwitch = agentSwitchIntent?.target === 'agy';", from);
    if (from < 0 || to < from) throw new Error('the composer code for the two confirmations was not found');
    const compiled = ts.transpileModule(source.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const intent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 7 };
    h.intent = intent;
    const modeRef = { current: 'ask' };
    const sendRef = { current: async (_id: string): Promise<boolean> => false };
    const permissionRef = { current: async (_id: string, _mode: string): Promise<boolean> => false };
    const env = {
      deviceLinkDeviceId: null, agySwitchPermissionPromptOpenRef: { current: false },
      agreeToPendingAgySwitchPermission, recordAgySwitchPermissionAgreementWithHost, agySwitchAgreementPurposeOfComposerDialog,
      agentSwitchIntent: intent, runtimeAgentKind: 'claude-code', confirmDialog: vi.fn(async () => true),
      agyPermissionChangeTitle: () => 'title', activeAgentCapabilities: undefined, t: (key: string) => key,
      makerChatStore: { getAgentSwitchIntent: () => h.intent }, log: { warn: vi.fn() }, toast: { error: h.toastError },
      activePermissionModeRef: modeRef,
      confirmPendingAgySwitchPermissionRef: sendRef, confirmPermissionChangeDuringAgySwitchRef: permissionRef,
    };
    new Function(...Object.keys(env), compiled)(...Object.values(env));
    const requests = () => h.registerWithHost.mock.calls.map((call) => call[6] as Record<string, unknown>);
    h.registerWithHost.mockClear();
    h.registerWithHost.mockResolvedValue({ agyPermissionAgreementRecorded: true });

    // The permission menu: the task is in a mode Antigravity keeps and the user picks Full access.
    forgetAgySwitchPermissionAgreed('task-1');
    await expect(permissionRef.current('task-1', 'bypassPermissions')).resolves.toBe(true);
    // No wake parameter; and which change it is, since the new mode is not stored yet.
    expect(requests()).toEqual([
      { agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementOnly: true, agyPermissionRevision: 7,
        agyPermissionChangingTo: 'bypassPermissions', agyPermissionChangingFrom: 'ask' },
    ]);

    // A send of a new message, in the mode the task is in: about the new message. It asks for
    // nothing held before it to be sent (QQ, 2026-11-23, "B").
    modeRef.current = 'bypassPermissions';
    h.registerWithHost.mockClear();
    forgetAgySwitchPermissionAgreed('task-1');
    await expect(sendRef.current('task-1')).resolves.toBe(true);
    expect(requests()).toEqual([
      { agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementOnly: true, agyPermissionRevision: 7 },
    ]);
    expect(env.confirmDialog).toHaveBeenCalledTimes(2);
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('gives a task view one key per state of the pending switch it has to act on again', () => {
    const base: AgySwitchPermissionPendingIntent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 7 };
    const agreed = { ...base, agyPermissionAgreement: { change: 'fromFullAccess' as const, mode: 'auto' } };
    expect(agySwitchPendingKey(null)).toBeNull();
    expect(agySwitchPendingKey(undefined)).toBeNull();
    const keys = [
      agySwitchPendingKey(base),
      agySwitchPendingKey({ ...base, agyPermissionRevision: 8 }),
      agySwitchPendingKey(agreed),
      agySwitchPendingKey({ ...agreed, agyPermissionAgreement: { change: 'fromUnsupported', mode: 'ask' } }),
      agySwitchPendingKey({ ...agreed, agyPermissionAgreementForSend: true }),
      agySwitchPendingKey({ ...base, target: 'codex' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    // Another model of the same registration state is not another occasion.
    expect(agySwitchPendingKey({ ...agreed, model: 'gemini-other' })).toBe(agySwitchPendingKey(agreed));
  });
});

describe('a message the host held for an unconfirmed permission change', () => {
  beforeEach(() => {
    // The host stamps each registration; every entry sends back the one it showed.
    h.intent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 7 };
    h.registerWithHost.mockClear();
    h.toastError.mockClear();
    h.hostAgreed = '';
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
      { agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementOnly: true, agyPermissionAgreementForSend: true, agyPermissionRevision: 7 },
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

  // Seen on Win11 while answering JJ (7081611824): a message held across a restart, with no
  // switch pending. The user picked a Gemini model again and agreed in the switch dialog; the
  // message stayed held and the banner asked them to confirm once more, because nothing told the
  // automatic step that a switch had appeared. It now runs then, and what was just agreed is used.
  it('asks the question of a send for a message held with no switch pending once the user picks the engine again and agrees to the conversion, and resends on its answer', async () => {
    h.intent = null;
    h.registerWithHost.mockResolvedValue({ agyPermissionAgreementRecorded: true });
    const onResend = vi.fn();
    const shown = render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    await settle();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(onResend).not.toHaveBeenCalled();

    // The model picker's own dialog was answered: the switch is registered with that agreement.
    // It is an agreement to the conversion; the held message is not resent on it (QQ, 2026-11-23).
    h.intent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 9,
      agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' } };
    noteAgySwitchPermissionAgreed('task-1', 'bypassPermissions');
    shown.rerender(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    const confirm = await screen.findByRole('button', { name: CONFIRM });
    await settle();
    expect(onResend).not.toHaveBeenCalled();
    expect(h.registerWithHost).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(h.registerWithHost).toHaveBeenCalledTimes(1);
    shown.rerender(view({ error: null, mode: 'bypassPermissions', onResend }));
    await settle();
    expect(onResend).toHaveBeenCalledTimes(1);
  });

  // QQ's ruling on DD 7082445534, point e: when the host already has a valid agreement for this
  // registration and this very change, another window does not ask again. The answer was given on
  // this computer; asking twice adds nothing, and the host checks its own record when it applies
  // the switch whatever a window believes. An agreement for another change is not that answer.
  it('asks in this window too when the host already has an agreement for this change, even one given for a send elsewhere, and resends only on the answer', async () => {
    h.intent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 7,
      agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementForSend: true };
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    const confirm = await screen.findByRole('button', { name: CONFIRM });
    await settle();
    expect(onResend).not.toHaveBeenCalled();
    expect(h.registerWithHost).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    // The answer is told to the host as one given for this send, with what this window knew to
    // be on record, without which the host replaces nothing.
    expect(h.registerWithHost).toHaveBeenCalledExactlyOnceWith(
      'task-1', 'agy', 'gemini-test', null, undefined, undefined,
      { agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementOnly: true, agyPermissionAgreementForSend: true,
        agyPermissionAgreementExpected: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionRevision: 7 },
    );
  });

  // JJ 7084937114. The task's own entry says that confirming sends no message. An agreement the
  // host has from there (the entry was open in another window, or was answered just as this
  // message came to be held) covered the change, so this window resent the held message on its
  // own: a send the user was told would not happen. Such a record is not acted on. The question
  // of a send is asked instead, and its answer, told to the host as one, sends the message once.
  it('does not resend on an agreement recorded by the task entry: asks the question of a send, and sends once on its answer', async () => {
    h.intent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 7,
      agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' } };
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    expect(await screen.findByText(TITLE)).toBeTruthy();
    await settle();
    expect(onResend).not.toHaveBeenCalled();
    expect(h.registerWithHost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(h.registerWithHost).toHaveBeenCalledExactlyOnceWith(
      'task-1', 'agy', 'gemini-test', null, undefined, undefined,
      { agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementOnly: true, agyPermissionAgreementForSend: true,
        agyPermissionAgreementExpected: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionRevision: 7 },
    );
  });

  it('asks when what the host has is for another change than the one that would happen now', async () => {
    h.intent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 7,
      agyPermissionAgreement: { change: 'fromUnsupported', mode: 'ask' } };
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(onResend).not.toHaveBeenCalled();
  });

  it('asks from the banner even when the host has an agreement: that action is the question', async () => {
    h.intent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 7,
      agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementForSend: true };
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: DECLINE }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    expect(onResend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(onResend).not.toHaveBeenCalled();
  });

  // QQ's ruling "A": an ordinary change of the permission mode records its agreement and sends
  // nothing. Before, this window resent the held message on what the permission menu's dialog
  // had just left behind. It asks the question of a send for the new mode instead.
  it('does not resend when the user has since agreed in the permission menu: asks the question of a send, once', async () => {
    const onResend = vi.fn();
    const shown = render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: DECLINE }));
    await waitFor(() => expect(screen.queryByText(TITLE)).toBeNull());
    // The permission menu's own dialog recorded the agreement and stored another mode.
    noteAgySwitchPermissionAgreed('task-1', 'acceptEdits');
    h.intent = { ...h.intent!, agyPermissionAgreement: { change: 'fromUnsupported', mode: 'ask' } };
    h.hostAgreed = 'fromUnsupported:ask';
    shown.rerender(view({ error: HELD, mode: 'acceptEdits', onResend }));
    const confirm = await screen.findByRole('button', { name: CONFIRM });
    await settle();
    expect(onResend).not.toHaveBeenCalled();
    expect(h.registerWithHost).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(h.registerWithHost.mock.calls.map((call) => call[6])).toEqual([
      { agyPermissionAgreement: { change: 'fromUnsupported', mode: 'ask' }, agyPermissionAgreementOnly: true, agyPermissionAgreementForSend: true,
        agyPermissionAgreementExpected: { change: 'fromUnsupported', mode: 'ask' }, agyPermissionRevision: 7 },
    ]);
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
    await waitFor(() => expect(h.toastError).toHaveBeenCalledExactlyOnceWith('newChat.chatInput.agentSwitch.permissionAgreementNotRecorded'));
    expect(onResend).not.toHaveBeenCalled();
    // Trying again asks again: the answer that was not recorded is not remembered here either.
    expect(readAgySwitchPermissionAgreed('task-1')).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(TITLE)).toBeTruthy();
  });

  // DD 7082445534, item 3: the host answering "that switch is no longer the pending one" is not
  // the user saying no, and used to look exactly like it: nothing happened. What is pending now
  // decides. Nothing pending for Antigravity: nothing is left to agree to, and the message goes.
  // DD 7083915988, item 5: with the switch withdrawn, resending the held message only earns one
  // more refusal from the host (the message was written for an engine the task is not going to).
  // Nothing is sent and nothing is reported as failed; the banner then reads "that switch is no
  // longer pending" (ErrorLocalization.test.tsx).
  it('does not resend the held message when the switch it was asked about was withdrawn in the meantime', async () => {
    h.registerWithHost.mockImplementationOnce(async () => { h.intent = null; return { agyPermissionAgreementRecorded: false }; });
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledTimes(1));
    await settle();
    expect(onResend).not.toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
    expect(readAgySwitchPermissionAgreed('task-1')).toBeUndefined();
  });

  it('asks about the switch that replaced the one it was asked about, and resends once that one is agreed', async () => {
    h.registerWithHost.mockImplementationOnce(async () => {
      h.intent = { target: 'agy', model: 'gemini-other', providerId: null, agyPermissionRevision: 8 };
      return { agyPermissionAgreementRecorded: false };
    });
    h.registerWithHost.mockResolvedValueOnce({ agyPermissionAgreementRecorded: true });
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledTimes(1));
    expect(onResend).not.toHaveBeenCalled();
    // Asked again, about the new one.
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(h.registerWithHost.mock.calls.map(call => [call[2], (call[6] as { agyPermissionRevision?: number }).agyPermissionRevision]))
      .toEqual([['gemini-test', 7], ['gemini-other', 8]]);
  });

  it('says that it did not work when the host will not take the answer for the switch that still stands', async () => {
    h.registerWithHost.mockResolvedValueOnce({ agyPermissionAgreementRecorded: false });
    const onResend = vi.fn();
    render(view({ error: HELD, mode: 'bypassPermissions', onResend }));
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledExactlyOnceWith('newChat.chatInput.agentSwitch.permissionAgreementNotRecorded'));
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
  const waiting: AgySwitchPermissionPendingIntent = {
    target: 'agy', model: 'gemini-test', providerId: null, agyPermissionAgreement: null, agyPermissionRevision: 3,
  };
  type EntryProps = { intent: AgySwitchPermissionPendingIntent | null; mode: string; partner?: boolean; running?: string };
  function Entry({ intent, mode, partner = false, running = 'claude-code' }: EntryProps) {
    const { confirm } = useConfirmDialog();
    return <AgySwitchPermissionPendingNotice sessionId="task-1" intent={intent} runningAgent={running}
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
    ['the task already runs Antigravity', { intent: waiting, mode: 'bypassPermissions', running: 'agy' }, false],
    ['the pending switch is to another engine', { intent: { ...waiting, target: 'codex' }, mode: 'bypassPermissions' }, false],
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
      { agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionAgreementOnly: true, agyPermissionRevision: 3 },
    ));
    expect(h.toastError).not.toHaveBeenCalled();
  });

  // DD 7085158660, test gaps: the notice that a confirmation was not recorded was only checked on
  // the banner of a held message. Here for the entry: it says so in the words agreed for it
  // (JJ 7083819560), keeps nothing of the answer, and the same question opens again.
  it.each([
    ['will not take the answer', () => h.registerWithHost.mockResolvedValueOnce({ agyPermissionAgreementRecorded: false })],
    ['cannot be reached', () => h.registerWithHost.mockRejectedValueOnce(new Error('no host'))],
  ])('says that the confirmation was not recorded when the host %s, and asks the same question again on the next try', async (_name, hostFails) => {
    hostFails();
    render(entry({ intent: waiting, mode: 'bypassPermissions' }));
    fireEvent.click(screen.getByRole('button', { name: REVIEW }));
    fireEvent.click(await screen.findByRole('button', { name: AGREE }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledExactlyOnceWith('newChat.chatInput.agentSwitch.permissionAgreementNotRecorded'));
    await waitFor(() => expect(screen.queryByText(ENTRY_TITLE)).toBeNull());
    expect(readAgySwitchPermissionAgreed('task-1')).toBeUndefined();
    expect(screen.getByText(NOTICE)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: REVIEW }));
    fireEvent.click(await screen.findByRole('button', { name: AGREE }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledTimes(2));
    expect(h.toastError).toHaveBeenCalledTimes(1);
  });

  // The answer is for the switch that was shown. When the host says another one is pending by
  // then, the user is asked about that one instead of being left with a notice that did nothing.
  it('answers only for the switch it showed, then asks about the one that replaced it', async () => {
    const shown = render(entry({ intent: waiting, mode: 'bypassPermissions' }));
    fireEvent.click(screen.getByRole('button', { name: REVIEW }));
    await screen.findByText(ENTRY_TITLE);
    // Another Gemini model is picked elsewhere while the dialog is open; the host will say so.
    h.registerWithHost.mockResolvedValueOnce({ agyPermissionAgreementRecorded: false });
    shown.rerender(entry({ intent: { ...waiting, model: 'gemini-other', agyPermissionRevision: 4 }, mode: 'bypassPermissions' }));
    fireEvent.click(screen.getByRole('button', { name: AGREE }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledTimes(1));
    expect(h.registerWithHost.mock.calls[0]![2]).toBe('gemini-test');
    expect(h.registerWithHost.mock.calls[0]![6]).toMatchObject({ agyPermissionRevision: 3 });

    fireEvent.click(await screen.findByRole('button', { name: AGREE }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledTimes(2));
    expect(h.registerWithHost.mock.calls[1]![2]).toBe('gemini-other');
    expect(h.registerWithHost.mock.calls[1]![6]).toMatchObject({ agyPermissionRevision: 4 });
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('has nothing left to confirm once the switch it showed was withdrawn', async () => {
    const shown = render(entry({ intent: waiting, mode: 'bypassPermissions' }));
    fireEvent.click(screen.getByRole('button', { name: REVIEW }));
    await screen.findByText(ENTRY_TITLE);
    h.registerWithHost.mockResolvedValueOnce({ agyPermissionAgreementRecorded: false });
    shown.rerender(entry({ intent: null, mode: 'bypassPermissions' }));
    fireEvent.click(screen.getByRole('button', { name: AGREE }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.queryByText(ENTRY_TITLE)).toBeNull();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  // DD 7082445534, point d: the entry's dialog is open when a message of the same task gets
  // held. The held-message step used to queue the same question behind it. It waits instead.
  // QQ's ruling "A" (JJ 7084937114): the entry's answer sends nothing, here either. When its
  // dialog is answered the held message is not resent on it; the question of a send follows,
  // one dialog at a time, and its answer sends the message once.
  it("does not ask behind the entry's dialog when a message is held meanwhile, and does not resend on the entry's answer", async () => {
    h.intent = { target: 'agy', model: 'gemini-test', providerId: null, agyPermissionRevision: 3 };
    const onResend = vi.fn();
    const both = (error: string | null) => (
      <ConfirmDialogProvider>
        <Entry intent={waiting} mode="bypassPermissions" />
        <TaskView error={error} mode="bypassPermissions" onResend={onResend} />
      </ConfirmDialogProvider>
    );
    const shown = render(both(null));
    fireEvent.click(screen.getByRole('button', { name: REVIEW }));
    await screen.findByText(ENTRY_TITLE);
    shown.rerender(both(HELD));
    await settle();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: AGREE }));
    await waitFor(() => expect(h.registerWithHost).toHaveBeenCalledTimes(1));
    // The host's report of the agreement reaches the view: recorded, not given for a send.
    h.intent = { ...h.intent!, agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' } };
    h.hostAgreed = 'fromFullAccess:auto';
    shown.rerender(both(HELD));
    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    await settle();
    expect(onResend).not.toHaveBeenCalled();
    expect(h.registerWithHost.mock.calls.map((call) => (call[6] as { agyPermissionAgreementForSend?: true }).agyPermissionAgreementForSend))
      .toEqual([undefined]);

    fireEvent.click(screen.getByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(onResend).toHaveBeenCalledTimes(1));
    expect(h.registerWithHost.mock.calls.map((call) => (call[6] as { agyPermissionAgreementForSend?: true }).agyPermissionAgreementForSend))
      .toEqual([undefined, true]);
  });

  it.each([
    ['in a task of this computer with nothing held', { readOnly: false, remote: false, error: null }, true],
    ['when the task is only read', { readOnly: true, remote: false, error: null }, false],
    ['from a computer that controls the task remotely', { readOnly: false, remote: true, error: null }, false],
    ['while a held message shows its own banner', { readOnly: false, remote: false, error: HELD }, false],
    ['while another error is shown', { readOnly: false, remote: false, error: 'SEND_FAILED: boom' }, true],
  ])('the task view offers the entry %s', (_name, input, offered) => {
    expect(agySwitchPermissionEntryIsOffered(input)).toBe(offered);
  });
});
