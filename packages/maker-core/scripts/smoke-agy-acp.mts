import { decideCodingRequest, codingFixtureIntact } from './agy-coding-policy.js';
/**
 * Manual smoke test of AgyAgent against a real, signed-in `agy` (≥ 1.5) on this computer.
 * Uses temp directories and synthetic data only. Not part of CI.
 *
 *   pnpm --filter @cindy/maker-core exec tsx scripts/smoke-agy-acp.mts <scenario> --model gpt-oss-120b-medium
 *
 * Scenarios: basic | read | write | coding | deny | cancel | resume | long
 */
import { mkdtemp, readFile, writeFile, readdir, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgyAgent } from '../src/agents/agy/index.js';
import { assertAgyModelAllowed } from '../src/agents/agy/models.js';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '../src/types/events.js';
import type { AgentSessionHandle } from '../src/agents/base-agent.js';

const args = process.argv.slice(2);
const scenario = args[0] ?? 'basic';
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
const allowedModels = ['gpt-oss-120b-medium'] as const;
// Validate before executable lookup, temporary files, or authentication.
assertAgyModelAllowed(model, allowedModels);
if (args.includes('--allow')) throw new Error('Blanket permission approval is not supported by this smoke runner');
const stallMs = args.includes('--stall-ms') ? Number(args[args.indexOf('--stall-ms') + 1]) : undefined;
const binaryPath = process.env.AGY_BIN ?? execFileSync('sh', ['-c', 'command -v agy'], { encoding: 'utf8' }).trim();

const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const logger = { debug: () => {}, info: () => {}, warn: (m: string, d?: unknown) => log('WARN', m, JSON.stringify(d ?? {})), error: (m: string, d?: unknown) => log('ERROR', m, JSON.stringify(d ?? {})) };

function makeAgent() {
  return new AgyAgent({
    binaryPath, runtimeConfig: {}, logger: logger as never, agyStallTimeoutMs: stallMs, agyAllowedModels: allowedModels,
    onAgyRpcError: (diagnostic: unknown) => log('RPC_ERROR', JSON.stringify(diagnostic)),
    auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({ PYTHONDONTWRITEBYTECODE: '1' }), triggerLogin: async () => ({ authenticated: true }), logout: async () => {} },
  } as never);
}

interface TurnSummary { events: number; types: Record<string, number>; text: string; done?: Record<string, unknown>; error?: Record<string, unknown>; maxGapMs: number; ms: number; permissions: InteractionRequest[] }

async function runTurn(handle: AgentSessionHandle, prompt: string, opts: { abortAfterMs?: number; codingRoot?: string; expectedTests?: string } = {}): Promise<TurnSummary> {
  const summary: TurnSummary = { events: 0, types: {}, text: '', maxGapMs: 0, ms: 0, permissions: [] };
  let denied = false;
  handle.setInteractionResolver(async (request: InteractionRequest): Promise<InteractionDecision> => {
    summary.permissions.push(request);
    let decision: { behavior: 'allow' | 'deny'; reason: string } = { behavior: 'deny', reason: 'default-deny' };
    if (!denied && opts.codingRoot && opts.expectedTests !== undefined) {
      const root = opts.codingRoot;
      decision = await decideCodingRequest(request, root, {
        realpath,
        treeSafe: async () => {
          const pending = [root]; let checked = 0;
          while (pending.length) {
            const directory = pending.pop()!;
            for (const name of await readdir(directory)) {
              if (++checked > 256) return false;
              const target = path.join(directory, name); const info = await lstat(target);
              if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) return false;
              if (info.isDirectory()) pending.push(target);
            }
          }
          return true;
        },
        singleFile: async target => { const info = await lstat(target); return info.isFile() && !info.isSymbolicLink() && info.nlink === 1; },
        fixtureIntact: () => codingFixtureIntact(root, opts.expectedTests!, {
          names: directory => readdir(directory), text: file => readFile(file, 'utf8'),
        }),
      });
    }
    log('PERMISSION_DECISION', JSON.stringify({ kind: request.kind, behavior: decision.behavior, reason: decision.reason }));
    if (decision.behavior === 'deny' && opts.codingRoot) {
      denied = true;
      setImmediate(() => { void handle.abort().catch(() => log('CANCEL_UNCONFIRMED')); });
    }
    return { kind: 'permission', behavior: decision.behavior } as InteractionDecision;
  });
  const started = Date.now();
  let last = started;
  const iterator = handle.events()[Symbol.asyncIterator]();
  await handle.send({ type: 'user', content: prompt });
  if (opts.abortAfterMs !== undefined) setTimeout(() => { log('ABORT requested'); void handle.abort(); }, opts.abortAfterMs);
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const event: AgentEvent = next.value;
    const now = Date.now();
    summary.maxGapMs = Math.max(summary.maxGapMs, now - last);
    last = now;
    summary.events++;
    summary.types[event.type] = (summary.types[event.type] ?? 0) + 1;
    const data = event.data as Record<string, unknown>;
    if (event.type === 'text') summary.text += String(data.text ?? '');
    if (event.type === 'tool_use') log('TOOL', data.toolName, JSON.stringify(data.input).slice(0, 160));
    if (event.type === 'status' && typeof data.status === 'string' && data.status !== 'Working') log('STATUS', data.status);
    if (event.type === 'done') { summary.done = data; break; }
    if (event.type === 'error') {
      // RPC_ERROR already carries the safe diagnostic; never echo raw event errors.
      const failure = { isTerminal: data.isTerminal === true };
      log('ERROR_EVENT', JSON.stringify(failure));
      if (data.isTerminal) { summary.error = failure; break; }
    }
  }
  summary.ms = Date.now() - started;
  return summary;
}

function report(name: string, summary: TurnSummary) {
  log(`RESULT ${name}`, JSON.stringify({ ms: summary.ms, maxGapMs: summary.maxGapMs, events: summary.events, types: summary.types,
    text: summary.text.slice(0, 300), done: summary.done && { stopReason: summary.done.stopReason, cancelled: summary.done.cancelled, tokenUsage: summary.done.tokenUsage, outputTokens: summary.done.outputTokens, contextTokens: summary.done.contextTokens },
    error: summary.error, permissions: summary.permissions.length }));
}

// Presence-only metadata: never collect argv or arbitrary environment values.
const environmentNames = ['HOME', 'AGY_BIN', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
  'DISPLAY', 'WAYLAND_DISPLAY', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'];
const parents: Array<{ pid: number; ppid: number; name: string }> = [];
let ancestor = process.pid;
if (process.platform === 'linux') {
  for (let depth = 0; depth < 12 && ancestor > 0; depth++) {
    try {
      const status = await readFile(`/proc/${ancestor}/status`, 'utf8');
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
      const name = /^Name:\s+([^\n]+)/m.exec(status)?.[1] ?? 'unknown';
      if (!Number.isSafeInteger(ppid)) break;
      parents.push({ pid: ancestor, ppid, name: /^[a-zA-Z0-9_.-]{1,32}$/.test(name) ? name : '[REDACTED]' });
      ancestor = ppid;
    } catch { break; }
  }
}
log('PREFLIGHT', JSON.stringify({ platform: process.platform,
  environment: Object.fromEntries(environmentNames.map(name => [name, Object.hasOwn(process.env, name)])),
  parents, parentChainComplete: ancestor === 0 }));

// Offline preview: no native process, auth check, or temporary task.
if (args.includes('--preflight-only')) process.exit(0);

async function main(): Promise<void> {
const dir = await mkdtemp(path.join(tmpdir(), `agy-smoke-${scenario}-`));
log('scenario', scenario, 'model', model, 'binary', binaryPath, 'cwd', dir);
const agent = makeAgent();
const start = (resumeSessionId?: string) => agent.startSession({ workingDir: dir, model, permissionMode: 'ask', ...(resumeSessionId ? { resumeSessionId } : {}) });
let handle = await start().catch(async error => {
  await agent.dispose().catch(() => {});
  throw error;
});
log('session', handle.id, 'model receipt', handle.model);
try {
  switch (scenario) {
    case 'basic':
      report('basic', await runTurn(handle, 'Reply with exactly the word READY and nothing else.'));
      break;
    case 'read':
      await writeFile(path.join(dir, 'notes.txt'), 'synthetic-token: HERON-2290\n');
      report('read', await runTurn(handle, 'Read the file notes.txt in the current directory and reply with only the synthetic-token value.'));
      break;
    case 'write': {
      report('write', await runTurn(handle, 'Create a file named hello.txt containing the single word hi. Then run the shell command `ls -la` in the current directory and tell me its output.'));
      log('FILES', JSON.stringify(await readdir(dir)), 'hello.txt:', await readFile(path.join(dir, 'hello.txt'), 'utf8').catch(() => '<absent>'));
      break;
    }
    case 'coding': {
      await writeFile(path.join(dir, 'calculator.py'), 'def add(a, b):\n    return a - b\n');
      await writeFile(path.join(dir, 'test_calculator.py'), [
        'import unittest', 'from calculator import add', '',
        'class AddTests(unittest.TestCase):',
        '    def test_positive(self): self.assertEqual(add(2, 3), 5)',
        '    def test_negative(self): self.assertEqual(add(-2, -3), -5)',
        '    def test_zero(self): self.assertEqual(add(0, 0), 0)',
        '', "if __name__ == '__main__': unittest.main()", '',
      ].join('\n'));
      report('coding', await runTurn(handle, 'In this synthetic directory, fix calculator.py so all existing tests in test_calculator.py pass. Make only the minimal operator correction; do not change tests or add imports/files. Run exactly python3 -m unittest -v and report the result. If permission is denied, stop; do not use another route.', { codingRoot: dir, expectedTests: await readFile(path.join(dir, 'test_calculator.py'), 'utf8') }));
      break;
    }
    case 'deny':
      report('deny', await runTurn(handle, 'Request permission to run the shell command printf DENY_PROBE. If denied, stop and report the denial. Do not run it with another tool or retry.'));
      break;
    case 'cancel':
      report('cancel', await runTurn(handle, 'Count slowly from 1 to 400, one number per line, and explain each number in one sentence.', { abortAfterMs: 4_000 }));
      report('after-cancel', await runTurn(handle, 'Reply with exactly the word AGAIN.'));
      break;
    case 'resume': {
      const first = await runTurn(handle, 'Remember the synthetic code word OSPREY-73. Reply with only OK.');
      report('resume-1', first);
      if (first.error || first.permissions.length || first.done?.stopReason !== 'end_turn' || first.done?.cancelled || first.text.trim() !== 'OK') throw new Error('FIRST_TURN_NOT_SUCCESSFUL');
      const id = handle.id;
      await handle.close();
      log('process closed; restarting with resumeSessionId', id);
      handle = await start(id);
      log('resumed session', handle.id, 'model receipt', handle.model);
      if (handle.id !== id || handle.model !== model) throw new Error('RESUMED_ID_OR_MODEL_MISMATCH');
      report('resume-2', await runTurn(handle, 'What was the synthetic code word I asked you to remember? Reply with only the code word.'));
      break;
    }
    case 'long': {
      const files = Array.from({ length: 12 }, (_, index) => `data-${String(index).padStart(2, '0')}.csv`);
      for (const [index, file] of files.entries()) {
        await writeFile(path.join(dir, file), ['id,value', ...Array.from({ length: 80 }, (_, row) => `${row},${(row * 37 + index * 11) % 101}`)].join('\n'));
      }
      report('long', await runTurn(handle, [
        'This is a long multi-step synthetic task in the current directory. Work through every step fully; do not stop early.',
        `The files are: ${files.join(', ')}.`,
        '1. For each file, read it with your file tool, then write <name>.stats.md containing count, sum, min, max, mean and median of the value column.',
        '2. Write a Python script analyze.py that recomputes the same statistics for all files, run it with python3, and save its output to check.txt.',
        '3. Compare every number in your .stats.md files with check.txt and fix any mismatch.',
        '4. Write summary.md: one table row per file, a section on outliers, and a section describing any mismatches you fixed.',
        '5. Finally reply with the overall total of all values across all files and the number of mismatches you fixed.',
      ].join('\n')));
      log('FILES', JSON.stringify(await readdir(dir)));
      break;
    }
    default: throw new Error(`unknown scenario ${scenario}`);
  }
} finally {
  await handle.close().catch(() => log('CLEANUP_UNCONFIRMED'));
  await agent.dispose().catch(() => {});
}
log('done', scenario);

}
// Native errors may include private message/data: only RPC_ERROR is diagnostic.
void main().catch(() => {
  log('FAILURE', JSON.stringify({ reason: 'agy_smoke_failed' }));
  process.exitCode = 1;
});
