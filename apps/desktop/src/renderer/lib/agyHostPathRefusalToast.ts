/**
 * agyHostPathRefusalToast — entries without a text channel of their own (xdt-file / xdt-audio media
 * protocols) refuse a link out of an agy task folder with a bare 403. The host pushes JJ's sentence
 * (good-night-oppie/cindy#15) and this shows it once per path; the host already picked the language.
 */

import { toast } from './toast';

const QUIET_MS = 60_000;
const lastShownAt = new Map<string, number>();

interface AgyHostPathRefusedPayload {
  message: string;
  key: string;
}

export function handleAgyHostPathRefused(payload: AgyHostPathRefusedPayload): void {
  if (!payload || typeof payload.message !== 'string' || !payload.message || typeof payload.key !== 'string') return;
  const now = Date.now();
  const last = lastShownAt.get(payload.key);
  if (last !== undefined && now - last < QUIET_MS) return;
  lastShownAt.set(payload.key, now);
  toast.warning(payload.message);
}

/** Installed once at renderer start (App.tsx), next to the network-error toast. */
export function installAgyHostPathRefusalToastListener(): () => void {
  return window.electronAPI.onAgyHostPathRefused(handleAgyHostPathRefused);
}
