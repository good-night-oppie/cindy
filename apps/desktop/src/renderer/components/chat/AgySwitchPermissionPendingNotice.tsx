import { useCallback, useRef, type CSSProperties } from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import { ErrorNotice } from '@/components/ui/error-notice';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  agreeToPendingAgySwitchPermission,
  agySwitchPermissionAwaitsAgreement,
  forgetAgySwitchPermissionAgreed,
  type AgySwitchPermissionPendingIntent,
} from '@/components/new-chat/agentSwitchConfirmation';
import { recordAgySwitchPermissionAgreementWithHost } from '@/components/new-chat/agySwitchPermissionHost';

interface Props {
  sessionId: string;
  /** The pending switch as this computer's host reports it. */
  intent: AgySwitchPermissionPendingIntent | null | undefined;
  runningAgent: string | null | undefined;
  permissionMode: string | null | undefined;
  /** A partner's conversation, where a switch staged by the partner's settings follows its policy. */
  partnerConversation: boolean;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  className?: string;
  style?: CSSProperties;
}

/**
 * The task's own entry to confirm the permission change of its pending switch into Antigravity,
 * shown for as long as the host has no agreement for it. It is where someone lands who was told,
 * in IM for instance, that their message was not processed and to confirm in the task: the host
 * kept no message, so confirming here agrees to the change and sends nothing; they send again.
 *
 * It states the change with the same text the switch dialog uses, asks afresh each time, and can
 * only answer for the switch it showed: the host drops an answer about a switch that has since
 * been withdrawn or replaced, and this notice then describes the new one. Declining leaves it in
 * place. A held queued message has its own banner, which also resends; the caller shows one of the two.
 */
export function AgySwitchPermissionPendingNotice({
  sessionId, intent, runningAgent, permissionMode, partnerConversation, confirm, className, style,
}: Props) {
  const { t } = useTranslation();
  const asking = useRef(false);
  const latest = useRef({ sessionId, intent, runningAgent, permissionMode, confirm });
  latest.current = { sessionId, intent, runningAgent, permissionMode, confirm };

  const review = useCallback(async () => {
    const asked = latest.current;
    if (asking.current || !asked.intent) return;
    asking.current = true;
    try {
      // What this window remembers is not what the host has: ask, whatever was answered before.
      forgetAgySwitchPermissionAgreed(asked.sessionId);
      await agreeToPendingAgySwitchPermission({
        sessionId: asked.sessionId,
        intent: asked.intent,
        runningAgent: asked.runningAgent,
        permissionMode: asked.permissionMode,
        confirm: asked.confirm,
        copy: {
          title: {
            fromFullAccess: t('newChat.chatInput.agentSwitch.permissionEntry.titleFromFullAccess'),
            fromUnsupported: t('newChat.chatInput.agentSwitch.permissionEntry.titleFromUnsupported'),
          },
          note: t('newChat.chatInput.agentSwitch.permissionEntry.note'),
          confirmText: t('newChat.chatInput.agentSwitch.permissionConfirmation.confirm'),
          cancelText: t('newChat.chatInput.agentSwitch.permissionConfirmation.cancel'),
        },
        t,
        registerWithHost: (pending, agreement) =>
          recordAgySwitchPermissionAgreementWithHost(asked.sessionId, pending, agreement),
        // Rendered from the host's report, so it is what is pending now.
        currentIntent: () => latest.current.intent,
        askAfresh: true,
      });
    } catch {
      toast.error(t('newChat.chatInput.agentSwitch.permissionAgreementNotRecorded'));
    } finally {
      asking.current = false;
    }
  }, [t]);

  if (!agySwitchPermissionAwaitsAgreement({ intent, runningAgent, permissionMode, partnerConversation })) return null;
  return (
    <ErrorNotice
      className={cn('mx-auto', className)}
      style={style}
      data-testid="agy-switch-permission-pending-notice"
      data-banner-kind="agy-switch-permission-pending"
      // Waiting for the user, not a failure: the neutral mark the held-message banner uses.
      icon={<Info size={16} className="text-[var(--text-secondary)]" />}
      message={t('newChat.chatInput.agentSwitch.permissionEntry.notice')}
      actions={(
        <Button size="sm" compact type="button" onClick={() => void review()}>
          {t('chat.errorBanner.agentSwitchPermissionReview')}
        </Button>
      )}
    />
  );
}
