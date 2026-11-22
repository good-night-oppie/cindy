import { makerApiFor } from '@/lib/makerTransport';

/**
 * Tells the task's host that the user agreed to the permission change of the switch into
 * Antigravity they were asked about. The host attaches it to that switch only if it is still the
 * pending one, and does nothing else: it registers no switch and sends no message. Its answer
 * says whether it was recorded (see agreeToPendingAgySwitchPermission).
 */
export function recordAgySwitchPermissionAgreementWithHost(
  sessionId: string,
  askedAbout: { model: string; providerId: string | null; effort?: string; fastMode?: boolean | 'ultrafast' },
  agreement: { change: 'fromFullAccess' | 'fromUnsupported' | null; mode: string },
): Promise<unknown> {
  return makerApiFor(sessionId).switchSessionAgent(
    sessionId, 'agy', askedAbout.model, askedAbout.providerId, askedAbout.effort, askedAbout.fastMode,
    { agyPermissionAgreement: agreement, agyPermissionAgreementOnly: true },
  );
}
