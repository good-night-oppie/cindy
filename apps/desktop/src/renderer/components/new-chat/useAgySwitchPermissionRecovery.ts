import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import { makerApiFor } from '@/lib/makerTransport';
import { makerChatStore } from '@/lib/makerChatStore';
import {
  agreeToPendingAgySwitchPermission, forgetAgySwitchPermissionAgreed, isAgentSwitchPermissionUnconfirmedError,
} from './agentSwitchConfirmation';

/**
 * The host held a message (a queued one, usually) because applying the pending switch into
 * Antigravity would rewrite the task's permissions in a way nobody agreed to: the mode was changed
 * from another window, a device or IM. The message is still at the head of the queue and the
 * switch is still pending.
 *
 * Automatically, at most once per pending switch and stored mode: ask with the dialog a send shows
 * (or, when the user has just agreed in the permission menu, use that), tell the host, and resend
 * the held message once. A retry clears the error before the host answers, so "the error went away
 * and came back" is not a new occasion: if the host holds the message again, nothing more happens
 * on its own. The banner stays, and its action asks the user afresh, never trusting an agreement
 * the host has just shown it does not have.
 *
 * On another computer controlling the task the host accepts no agreement, so nothing is asked
 * there and the banner says where to confirm.
 *
 * Returns the retry action for the error banner.
 */
export function useAgySwitchPermissionRecovery(input: {
  sessionId: string | null | undefined;
  error: string | null | undefined;
  runningAgent: string | null | undefined;
  permissionMode: string | null | undefined;
  /** The task runs on another computer that this window controls. */
  remote: boolean;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  retry: () => void;
}): () => void {
  const { t } = useTranslation();
  const latest = useRef(input);
  latest.current = input;
  const asking = useRef(false);
  /** Stored modes this pending switch was already recovered for automatically, per task. */
  const automaticallyTried = useRef<{ sessionId: string; modes: Set<string> } | null>(null);

  const recover = useCallback(async (askAfresh: boolean) => {
    const { sessionId, runningAgent, permissionMode, confirm, retry } = latest.current;
    if (!sessionId || asking.current) return;
    asking.current = true;
    try {
      if (askAfresh) forgetAgySwitchPermissionAgreed(sessionId);
      const agreed = await agreeToPendingAgySwitchPermission({
        sessionId,
        intent: makerChatStore.getAgentSwitchIntent(sessionId),
        runningAgent,
        permissionMode,
        confirm,
        copy: {
          title: {
            fromFullAccess: t('newChat.chatInput.agentSwitch.sendConfirmation.titleFromFullAccess'),
            fromUnsupported: t('newChat.chatInput.agentSwitch.sendConfirmation.titleFromUnsupported'),
          },
          confirmText: t('newChat.chatInput.agentSwitch.sendConfirmation.confirm'),
          cancelText: t('newChat.chatInput.agentSwitch.sendConfirmation.cancel'),
        },
        t,
        registerWithHost: (intent, agreement) => makerApiFor(sessionId).switchSessionAgent(
          sessionId, 'agy', intent.model, intent.providerId, intent.effort, intent.fastMode,
          { agyPermissionAgreement: agreement },
        ),
      });
      if (agreed) retry();
    } catch {
      // The host did not record the agreement: the message stays held and the banner stays.
      toast.error(t('newChat.chatInput.agentSwitch.failed'));
    } finally {
      asking.current = false;
    }
  }, [t]);

  const held = !input.remote && isAgentSwitchPermissionUnconfirmedError(input.error);
  const { sessionId, permissionMode } = input;
  useEffect(() => {
    if (!sessionId) return;
    if (automaticallyTried.current?.sessionId !== sessionId) automaticallyTried.current = { sessionId, modes: new Set() };
    // The record lasts as long as the pending switch does, not as long as the error text: a retry
    // clears the error first, and the host's next refusal would otherwise look like a new one.
    if (makerChatStore.getAgentSwitchIntent(sessionId)?.target !== 'agy') {
      automaticallyTried.current.modes.clear();
      return;
    }
    if (!held) return;
    const mode = permissionMode ?? '';
    if (automaticallyTried.current.modes.has(mode)) return;
    automaticallyTried.current.modes.add(mode);
    void recover(false);
  }, [held, sessionId, input.error, permissionMode, recover]);

  return useCallback(() => {
    const now = latest.current;
    if (!now.remote && isAgentSwitchPermissionUnconfirmedError(now.error)) void recover(true);
    else now.retry();
  }, [recover]);
}
