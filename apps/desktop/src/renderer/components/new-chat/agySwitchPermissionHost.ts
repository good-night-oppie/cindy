import { makerApiFor } from '@/lib/makerTransport';

/**
 * Tells the task's host that the user agreed to the permission change of the switch into
 * Antigravity they were asked about. The host attaches it to that switch only if it is still the
 * pending one and registers no switch. Its answer says whether it was recorded (see
 * agreeToPendingAgySwitchPermission).
 *
 * `purpose` is what the user was told on screen. 'send': they confirmed on the banner of a held
 * message that it should go; the host then lets that message go. 'recordOnly': everything else
 * (the task's own entry, the permission menu, the dialog of a new message's send); the host
 * records the agreement and sends nothing it was holding.
 */
/**
 * What an agreement given in one of the composer's dialogs is for, as far as a message the host
 * already holds is concerned: nothing (QQ's rulings of 2026-11-22 and 2026-11-23).
 *  - The permission menu's "Confirm change" changes a setting.
 *  - The dialog shown when a new message is sent is about that new message. A message held or
 *    paused before it stays where it is, ahead of the new one, until the user confirms on its
 *    banner or continues the queue.
 * Only the banner of the held message itself asks the host to let that message go.
 */
export function agySwitchAgreementPurposeOfComposerDialog(
  _about: 'sendConfirmation' | 'permissionConfirmation',
): 'send' | 'recordOnly' {
  return 'recordOnly';
}

export function recordAgySwitchPermissionAgreementWithHost(
  sessionId: string,
  askedAbout: {
    model: string; providerId: string | null; effort?: string; fastMode?: boolean | 'ultrafast';
    /** The registration the user was shown, as the host reported it. Without it the host records nothing. */
    agyPermissionRevision?: number;
    /**
     * What the host reported as agreed for it when the user was asked. Sent back so that the host
     * replaces a record only for a caller that knew it; the host refuses a write that would
     * replace a different agreement the caller had not seen.
     */
    agyPermissionAgreement?: { change: 'fromFullAccess' | 'fromUnsupported' | null; mode: string } | null;
  },
  agreement: { change: 'fromFullAccess' | 'fromUnsupported' | null; mode: string },
  purpose: 'send' | 'recordOnly',
  /**
   * The user is confirming a change of the permission mode: the mode they are changing to and the
   * one this window shows the task in. The host takes the agreement as one about the new mode
   * only while the task is still in the old one. Left out everywhere else, where the agreement is
   * about the mode the task is in.
   */
  changing?: { to: string; from: string | null | undefined },
): Promise<unknown> {
  return makerApiFor(sessionId).switchSessionAgent(
    sessionId, 'agy', askedAbout.model, askedAbout.providerId, askedAbout.effort, askedAbout.fastMode,
    {
      agyPermissionAgreement: agreement, agyPermissionAgreementOnly: true,
      ...(purpose === 'send' ? { agyPermissionAgreementForSend: true } : {}),
      ...(askedAbout.agyPermissionAgreement ? { agyPermissionAgreementExpected: askedAbout.agyPermissionAgreement } : {}),
      ...(changing && typeof changing.from === 'string' ? { agyPermissionChangingTo: changing.to, agyPermissionChangingFrom: changing.from } : {}),
      ...(askedAbout.agyPermissionRevision !== undefined ? { agyPermissionRevision: askedAbout.agyPermissionRevision } : {}),
    },
  );
}
