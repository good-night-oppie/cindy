import { makerApiFor } from '@/lib/makerTransport';

/**
 * Tells the task's host that the user agreed to the permission change of the switch into
 * Antigravity they were asked about. The host attaches it to that switch only if it is still the
 * pending one and registers no switch. Its answer says whether it was recorded (see
 * agreeToPendingAgySwitchPermission).
 *
 * `purpose` is what the user was told on screen. 'send': they agreed in order to send (the dialog
 * of a send or of a permission change, the banner of a held message); the host then lets a
 * message it held for this go. 'recordOnly': the task's own entry, which says that confirming
 * sends no message; the host records the agreement and sends nothing.
 */
/**
 * What the composer's two dialogs tell the host an agreement is for. The dialog of a send: the
 * message goes out with it, and so may one the host held for this. The dialog of the permission
 * menu ("Confirm change"): the user is changing a setting, and nothing is sent on it (QQ's
 * ruling "A", 2026-11-22), whatever is held and whichever window shows it.
 */
export function agySwitchAgreementPurposeOfComposerDialog(
  about: 'sendConfirmation' | 'permissionConfirmation',
): 'send' | 'recordOnly' {
  return about === 'sendConfirmation' ? 'send' : 'recordOnly';
}

export function recordAgySwitchPermissionAgreementWithHost(
  sessionId: string,
  askedAbout: {
    model: string; providerId: string | null; effort?: string; fastMode?: boolean | 'ultrafast';
    /** The registration the user was shown, as the host reported it. Without it the host records nothing. */
    agyPermissionRevision?: number;
  },
  agreement: { change: 'fromFullAccess' | 'fromUnsupported' | null; mode: string },
  purpose: 'send' | 'recordOnly',
): Promise<unknown> {
  return makerApiFor(sessionId).switchSessionAgent(
    sessionId, 'agy', askedAbout.model, askedAbout.providerId, askedAbout.effort, askedAbout.fastMode,
    {
      agyPermissionAgreement: agreement, agyPermissionAgreementOnly: true,
      ...(purpose === 'send' ? { agyPermissionAgreementForSend: true } : {}),
      ...(askedAbout.agyPermissionRevision !== undefined ? { agyPermissionRevision: askedAbout.agyPermissionRevision } : {}),
    },
  );
}
