import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';

// The three places where register.ts joins the pending-switch registry to the rest of the host
// for a switch into Antigravity (cindy#19), run from its source with their collaborators stood in:
//   - what the registry is created with (a held scheduled restore that was replaced or withdrawn
//     retires its saved model, not awaited);
//   - onPendingSwitchAgreed (an agreement given for a send lets the queue's held message go);
//   - onScheduledRestoreLanded (an applied scheduled restore retires its saved model, awaited).
// Tests used to write these three by hand, so removing a line from register.ts failed nothing.
const source = readFileSync(new URL('../../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const registryCall = '  const agentSwitchPending = createPendingAgentSwitchRegistry(';
const registryStart = source.indexOf(registryCall);
const registryEnd = source.indexOf('\n  });', registryStart);
const depsStart = source.indexOf('    onPendingSwitchAgreed: (sessionId) =>');
const depsEnd = source.indexOf('    onUserRouteSelectionLanded: async (sessionId) =>', depsStart);
if (registryStart < 0 || registryEnd < registryStart || depsStart < 0 || depsEnd < depsStart) {
  throw new Error('register.ts: the pending-switch wiring for Antigravity was not found');
}
const registryOptions = source.slice(registryStart + registryCall.length, registryEnd + '\n  }'.length);
const deps = source.slice(depsStart, depsEnd);
const compiled = transpileModule(`return { registryOptions: (${registryOptions}), deps: {\n${deps}\n} };`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

export interface AgySwitchWiringCollaborators {
  /** The queue coordinator, as register.ts holds it (may not be created yet). */
  agentInputCoordinatorHolder?: { wakeHeldForAgySwitch(sessionId: string): boolean } | null;
  /** Clears the task's saved model; resolves false when it had changed meanwhile. */
  updateScheduledPreference?: (sessionId: string, patch: null) => Promise<boolean>;
  log?: { warn: (...args: unknown[]) => void };
}

export function agySwitchWiringFromRegister(collaborators: AgySwitchWiringCollaborators = {}): {
  registryOptions: { onScheduledRestoreSettled(sessionId: string): void };
  deps: {
    onPendingSwitchAgreed(sessionId: string): void;
    onScheduledRestoreLanded(sessionId: string): Promise<void>;
  };
} {
  const bindings = {
    agentInputCoordinatorHolder: collaborators.agentInputCoordinatorHolder ?? null,
    updateScheduledPreference: collaborators.updateScheduledPreference ?? (async () => true),
    log: collaborators.log ?? { warn: () => undefined },
  };
  return new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
}
