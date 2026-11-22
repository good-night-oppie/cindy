import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import { makerApiFor } from '@/lib/makerTransport';
import { makerChatStore } from '@/lib/makerChatStore';
import { agreeToPendingAgySwitchPermission, isAgentSwitchPermissionUnconfirmedError } from './agentSwitchConfirmation';

/**
 * The host held a message (a queued one, usually) because applying the pending switch into
 * Antigravity would rewrite the task's permissions in a way nobody agreed to: the mode was changed
 * from another window, a device or IM. The message is still at the head of the queue and the
 * switch is still pending. Ask the user once, with the dialog a send shows; if they agree, tell the
 * host and resend the held message once. If they decline, nothing changes and nothing is retried.
 *
 * Returns the retry action for the error banner: for this error it asks again instead of resending
 * a message the host would hold again.
 */
export function useAgySwitchPermissionRecovery(input: {
  sessionId: string | null | undefined;
  error: string | null | undefined;
  runningAgent: string | null | undefined;
  permissionMode: string | null | undefined;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  retry: () => void;
}): () => void {
  const { t } = useTranslation();
  const latest = useRef(input);
  latest.current = input;
  const asking = useRef(false);
  const askedFor = useRef<string | null>(null);

  const recover = useCallback(async () => {
    const { sessionId, runningAgent, permissionMode, confirm, retry } = latest.current;
    if (!sessionId || asking.current) return;
    asking.current = true;
    try {
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
      // The host did not record the agreement: leave the message held; the banner still offers Retry.
    } finally {
      asking.current = false;
    }
  }, [t]);

  const held = isAgentSwitchPermissionUnconfirmedError(input.error);
  useEffect(() => {
    if (!held || !input.sessionId) {
      askedFor.current = null;
      return;
    }
    // Once per held message and stored mode: declining must not bring the dialog straight back,
    // and a resend the host holds again must not turn into a loop.
    const occurrence = `${input.sessionId}|${input.error}|${input.permissionMode ?? ''}`;
    if (askedFor.current === occurrence) return;
    askedFor.current = occurrence;
    void recover();
  }, [held, input.sessionId, input.error, input.permissionMode, recover]);

  return useCallback(() => {
    if (isAgentSwitchPermissionUnconfirmedError(latest.current.error)) void recover();
    else latest.current.retry();
  }, [recover]);
}
