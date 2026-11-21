/**
 * Google Antigravity CLI (`agy`) as a native Cindy runtime, over ACP v1 stdio.
 *
 * One `agy acp` process per Cindy session. Session lifecycle, interaction handling and
 * shutdown follow the Cursor ACP harness in makecindy/cindy#5611 (Ken / kenlinjie);
 * agy-specific behavior:
 *   - model / thought_level / mode are applied with session/set_config_option and the
 *     returned configOptions are the receipt. A send is blocked whenever the latest
 *     receipt differs from what the task requested — no silent substitution.
 *     Start and model switch require an exact model ID; trusted hosts may narrow
 *     selection with agyAllowedModels. The final receipt is checked after input preparation.
 *   - Cindy keeps agy in its native `default` mode (or `plan`); it never switches agy into
 *     `accept-edits` / `auto`, and never answers with `allow_always`.
 *   - A no-event watchdog reports silence without assuming a stall. Automatic
 *     cancellation requires an explicit silence budget; user stop remains available.
 *   - Missing / too-old binaries and sign-in failures are explicit errors; there is no
 *     fallback to another runtime.
 */
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import {
  BaseAgent, PINNED_SKILL_INVOCATION, AgentNotAuthenticatedError, AgentStartupStoppedError,
  AgentStartupCleanupPendingError, TurnPermissionPolicyUnsupportedError,
  type AgentDeps, type AgentSessionHandle, type StartSessionOptions, type SendOptions,
  isolatedBotProfile,
} from '../base-agent.js';
import { LIBRARY_READ_ROOT } from '../shared/library-native-read.js';
import { AcpClient, AcpRpcError } from '../acp/client.js';
import { spawnAcpTransport, type AcpTransport } from '../acp/transport.js';
import type { Capabilities } from '../../types/capabilities.js';
import { NotSupportedError } from '../../types/capabilities.js';
import type { Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type { AgentEvent, InteractionDecision, InteractionRequest, InteractionResolver } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { resolveMemoryScopeKey } from '../../memory/scope-resolver.js';
import type { ReviewableAction } from '../shared/auto-review.js';
import {
  appendAutoReviewUserIntent, normalizeAutoReviewUserIntent, createAutoReviewActionContext,
  resolveAutoReviewDecision, withAutoReviewContext, createAutoReviewUnavailableNotice,
  createAutoReviewConfirmUndeliveredNotice, annotatePermissionRequestForUnavailableReview,
  isSystemPermissionDenialReason, type AutoReviewUserIntent,
} from '../shared/auto-review-decision.js';
import {
  AGY_DEFAULT_MODE, AGY_EFFORT_CONFIG_ID, AGY_MODE_CONFIG_ID, AGY_MODEL_CONFIG_ID, AGY_PLAN_MODE,
  readAgyCatalog, record, type AcpRecord,
} from './models.js';
import { AgyTranslator, agyToolInput, agyToolName } from './translator.js';
import { agyReviewAction } from './permissions.js';
import { AgyStallWatchdog, resolveAgyStallTimeoutMs } from './watchdog.js';
import { assertAgyModelAllowed } from './models.js';
import { agyRpcDiagnostic, type AgyRpcDiagnostic } from './diagnostics.js';
import { assertAgyBinaryUsable, readAgyVersionOutput, AgyBinaryUnavailableError, type AgyVersionReader } from './version.js';
import {
  AGY_SANDBOX_USER_COPY_DRAFT, AgySandboxUnavailableError, agyPrivateStateMounts, prepareAgySandboxedLaunch, prepareAgyFullAccessLaunch,
  filterAgyUnsandboxedEnv,
  type AgySandboxProbe,
} from './system-sandbox.js';
import { openAgyTaskFile, registerAgyTaskDir } from './host-path-guard.js';

export { AGY_MIN_VERSION, AgyBinaryUnavailableError, parseAgyVersion } from './version.js';
export { AGY_DEFAULT_STALL_TIMEOUT_MS, AGY_STALL_TIMEOUT_ENV, resolveAgyStallTimeoutMs } from './watchdog.js';
export { readAgyCatalog } from './models.js';

/** Legacy sentinel, rejected at admission: callers must resolve an exact model. */
export const AGY_DEFAULT_MODEL = 'default';
export const AGY_ACP_ARGS = ['acp', '--disable-telemetry'] as const;

const yes = { supported: true } as const;
const no = { supported: false, reason: 'not-implemented' } as const;
// Wording pending JJ (cindy#1 6908586833 item 4): say exactly what the isolation does and does not do.
const NATIVE_PERMISSION_DESCRIPTION = 'Antigravity can change files in this task folder and its private CLI state. Cindy tools run on the host and may request access to other files. Cindy handles approval requests from the CLI and tools.';
// Used only where no system-level isolation exists (Windows, macOS). Wording pending JJ.
const UNSANDBOXED_PERMISSION_DESCRIPTION = 'Antigravity runs without system-level file isolation on this computer: it can reach any file your user account can, limited only by the approval requests it sends to Cindy. Requests outside this task\'s folder are worth reading before you allow them.';
// Same meaning as Full access on the other engines: no file isolation, network commands allowed, no questions.
const FULL_ACCESS_PERMISSION_DESCRIPTION = 'Antigravity runs without Cindy\x27s file isolation: it can read and change any file your account can, including outside this task\x27s folder, and run network commands. Cindy allows the approval requests agy sends without confirmation.';
const CONTROL_TIMEOUT = 30_000;
const CANCEL_TIMEOUT = 10_000;
const PROMPT_REQUEST_TIMEOUT = 24 * 60 * 60 * 1000;
const STOP_REASONS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];

export interface AgyAgentDeps extends AgentDeps {
  /** Local diagnostic opt-in; receives only bounded, redacted RPC errors. */
  onAgyRpcError?: (diagnostic: AgyRpcDiagnostic) => void;
  /** Optional trusted-host restriction; absent permits any explicitly selected catalog model. */
  agyAllowedModels?: readonly string[];
  /** Test/embedding seam; production spawns the exact host-resolved executable. */
  createAgyTransport?: (options: { binaryPath: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }) => AcpTransport;
  /** Test seam for `agy --version`. */
  readAgyVersion?: AgyVersionReader;
  /** Skip the binary/version preflight (tests with an injected transport only). */
  skipAgyBinaryPreflight?: boolean;
  /** Host default for the no-event stall limit; per-session `vendorOptions.agyStallTimeoutMs` wins. */
  agyStallTimeoutMs?: number;
  /**
   * System-level isolation (cindy#1 6908586833): always applied to the real spawn. With an injected
   * transport (tests) it is applied only when set. stateRoot defaults to ~/.cindy/agy-sandbox/state.
   */
  agySandbox?: {
    stateRoot?: string;
    probe?: AgySandboxProbe;
    /**
     * Non-Linux hosts (Windows, macOS) have no bwrap/pasta. When the product host sets this,
     * agy runs there without OS isolation: env is filtered, the UI is told, and the sandboxed
     * path still never falls back to this on its own (cindy#1, owner decision 2026-11-17).
     */
    allowWithoutSystemSandbox?: boolean;
    /** Expose the CLI's existing Google sign-in file read-only inside the sandbox (see system-sandbox). */
    shareCliLogin?: boolean;
  };
  /** UI locale for agy user notices (JJ's wording exists in zh-CN and en). */
  uiLocale?: () => string | null | undefined;
}

function bridgeLoopbackPort(raw: string): number | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port) return Number(url.port);
  } catch { /* Ignore malformed local bridge descriptors. */ }
  return undefined;
}

export class AgyAgent extends BaseAgent {
  readonly kind = 'agy' as const;
  readonly capabilities: Capabilities = {
    switchModel: yes, availableModels: [], hasFastMode: false,
    effort: no, effortLevels: [], reasoningDisplay: ['off', 'full'],
    permissionModes: [
      { id: 'ask', displayName: 'Default permissions', description: NATIVE_PERMISSION_DESCRIPTION },
      { id: 'default', displayName: 'Default permissions', description: NATIVE_PERMISSION_DESCRIPTION },
      { id: 'auto', displayName: 'Auto-review', description: `Cindy automatically reviews the approval requests agy sends. ${NATIVE_PERMISSION_DESCRIPTION}` },
      { id: 'bypassPermissions', displayName: 'Full access', description: FULL_ACCESS_PERMISSION_DESCRIPTION },
    ],
    setPermissionModeMidSession: yes,
    // ACP approvals cover only the requests agy chooses to send; Cindy cannot enforce a
    // per-tool read-only policy on agy's own tools.
    turnPermissionPolicy: { supported: no, unsupportedPermissionModes: ['ask', 'default', 'auto', 'bypassPermissions', 'acceptEdits', 'plan'] },
    planMode: yes,
    multimodal: { text: yes, image: no, file: yes },
    fork: no, rewind: no, abort: yes, sameTurnSteer: no,
    memory: { supported: no }, extraDirs: no, writableDirs: no,
  };
  private sessions = new Set<AgentSessionHandle>();
  private startups = new Map<AbortController, Promise<void>>();
  private failedStartupCleanups = new Map<string, {
    close: () => Promise<void>;
    pendingError: AgentStartupCleanupPendingError;
    confirmStopped: () => void;
    promise?: Promise<void>;
  }>();
  private disposed = false;
  private probePromise: Promise<void> | null = null;

  constructor(protected override deps: AgyAgentDeps) {
    super(deps);
    // Never claim file isolation on a host that has none (copy wording pending JJ).
    if (deps.agySandbox?.allowWithoutSystemSandbox) {
      this.capabilities = {
        ...this.capabilities,
        permissionModes: this.capabilities.permissionModes.map(mode => ({
          ...mode, description: (mode.description ?? '').replace(NATIVE_PERMISSION_DESCRIPTION, UNSANDBOXED_PERMISSION_DESCRIPTION),
        })),
      };
    }
  }

  private async retryFailedStartupCleanup(key: string): Promise<void> {
    const entry = this.failedStartupCleanups.get(key);
    if (!entry) return;
    const cleanup = entry.promise ?? entry.close();
    entry.promise = cleanup;
    try { await cleanup; } catch {
      if (entry.promise === cleanup) entry.promise = undefined;
      throw entry.pendingError;
    }
    if (this.failedStartupCleanups.get(key) === entry) {
      this.failedStartupCleanups.delete(key);
      entry.confirmStopped();
    }
  }

  private checkLaunchVersion(binaryPath: string, launch: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv },
    cliArgCount: number, cwd: string, isolation: 'host' | 'sandbox' | 'full'): Promise<string> {
    // The prepared launch ends in the CLI arguments; preserve its wrapper and all mount/network options.
    const args = [...launch.args.slice(0, -cliArgCount), '--version'];
    return assertAgyBinaryUsable(binaryPath, this.deps.readAgyVersion ?? (() =>
      readAgyVersionOutput(launch.command, args, { cwd, env: launch.env })), isolation);
  }

  /** Discover the catalog in an empty task directory with the normal isolation policy. */
  async probeModels(): Promise<void> {
    if (this.capabilities.availableModels.length) return;
    if (this.probePromise) return this.probePromise;
    this.probePromise = (async () => {
      const binaryPath = this.deps.binaryPath;
      if (!binaryPath) throw new Error('agy binary path is not configured');
      const config = this.deps.agySandbox;
      if (process.platform !== 'linux' && !config?.allowWithoutSystemSandbox) {
        throw new AgySandboxUnavailableError('unsupported-platform', process.platform);
      }
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'cindy-agy-models-'));
      let failed = false;
      try {
        const homeDir = os.homedir();
        const authEnv = await this.deps.auth.getAuthEnv();
        const env = { ...process.env, ...authEnv };
        const passEnvKeys = Object.keys(authEnv ?? {});
        const launch = process.platform === 'linux'
          ? await prepareAgySandboxedLaunch({ binaryPath, args: AGY_ACP_ARGS, taskDir: cwd,
              homeDir, env, passEnvKeys, probe: config?.probe, shareCliLogin: config?.shareCliLogin,
              stateRoot: config?.stateRoot ?? path.join(homeDir, '.cindy', 'agy-sandbox', 'state') })
          : { command: binaryPath, args: AGY_ACP_ARGS, env: filterAgyUnsandboxedEnv(env, homeDir, cwd, passEnvKeys) };
        await this.checkLaunchVersion(binaryPath, launch, AGY_ACP_ARGS.length, cwd,
          process.platform === 'linux' ? 'sandbox' : 'host');
        const transport = (this.deps.createAgyTransport ?? spawnAcpTransport)({
          binaryPath: launch.command, args: launch.args, cwd, env: launch.env,
        });
        const client = new AcpClient(transport, { requestTimeoutMs: CONTROL_TIMEOUT });
        let catalog: ReturnType<typeof readAgyCatalog>;
        let probeFailed = false;
        try {
          const init = record(await client.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'cindy', version: '1.0.0' },
          }));
          if (init.protocolVersion !== 1) throw new Error('agy ACP protocol version is unsupported');
          const result = record(await client.request('session/new', { cwd, mcpServers: [] }));
          catalog = readAgyCatalog(result);
        } catch (error) {
          probeFailed = true;
          throw error;
        } finally {
          try { await client.close(); } catch (closeError) {
            if (!probeFailed) throw closeError;
            this.deps.logger.warn('agy catalog probe also failed to close its transport');
          }
        }
        this.capabilities.availableModels = catalog.models;
        this.capabilities.switchModel = catalog.models.length ? yes : no;
        this.capabilities.effort = catalog.currentEfforts.length ? yes : no;
        this.capabilities.effortLevels = catalog.currentEfforts.map(id => ({ id, displayName: id }));
        this.capabilities.planMode = catalog.modes.includes(AGY_PLAN_MODE) ? yes : no;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        try {
          await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
        } catch (cleanupError) {
          if (!failed) throw cleanupError;
          this.deps.logger.warn('agy catalog probe could not remove its temporary directory');
        }
      }
    })();
    try { await this.probePromise; } finally { this.probePromise = null; }
  }

  override async dispose(): Promise<void> {
    this.disposed = true;
    for (const startup of this.startups.keys()) startup.abort();
    await Promise.allSettled([...this.startups.values()]);
    const results = await Promise.allSettled([
      ...[...this.failedStartupCleanups.keys()].map(key => this.retryFailedStartupCleanup(key)),
      ...[...this.sessions].map(session => session.close()),
    ]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'agy process cleanup is not confirmed');
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    const startup = new AbortController();
    let finish!: () => void;
    this.startups.set(startup, new Promise<void>(resolve => { finish = resolve; }));
    const cleanupKey = opts.sessionId ?? opts.resumeSessionId ?? opts.workingDir;
    try {
      if (this.disposed) throw new AgentStartupStoppedError(new Error('agy agent has been disposed'));
      await this.retryFailedStartupCleanup(cleanupKey);
      return await this.startSessionNow(opts, startup, cleanupKey);
    } finally {
      this.startups.delete(startup);
      finish();
    }
  }

  private async startSessionNow(opts: StartSessionOptions, startup: AbortController, cleanupKey: string): Promise<AgentSessionHandle> {
    const assertCurrent = () => { if (this.disposed || startup.signal.aborted) throw new Error('agy agent has been disposed'); };
    let client: AcpClient | undefined;
    const request = async (method: string, params: unknown, options?: Parameters<AcpClient['request']>[2]): Promise<unknown> => {
      try { return await client!.request(method, params, options); }
      catch (error) {
        if (error instanceof AcpRpcError && this.deps.onAgyRpcError) {
          try { this.deps.onAgyRpcError(agyRpcDiagnostic(method, error)); } catch { /* diagnostics cannot change execution */ }
        }
        throw error;
      }
    };
    const queue = createAsyncQueue<AgentEvent>();
    let sessionId = '';
    // Snapshot the host policy; session options cannot broaden it.
    const allowedModels = this.deps.agyAllowedModels?.slice();
    const requestedModel = opts.model;
    let wantedModel: string | undefined = requestedModel;
    let wantedEffort: Effort | undefined = opts.effort;
    let wantedPlan = opts.planMode === true;
    let model = requestedModel ?? AGY_DEFAULT_MODEL;
    let loading = true;
    let closed = false;
    let active: Promise<unknown> | undefined;
    let running = false;
    let cancelled = false;
    let stalled = false;
    let resolver: InteractionResolver | undefined;
    let mode: PermissionMode = opts.permissionMode ?? 'ask';
    let sessionState: AcpRecord = {};
    let turnOptions: SendOptions | undefined;
    let promptCapabilities: AcpRecord = {};
    let firstPrompt = !opts.resumeSessionId;
    let mcpServers: { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] }[] = [];
    let disposeMcp: (() => void) | undefined;
    let context = '';
    let closePromise: Promise<void> | undefined;
    let fenced = false;
    let preparingController: AbortController | undefined;
    let configuring = false;
    let permissionGeneration = 0;
    let userIntent: AutoReviewUserIntent = '';
    const actionContext = createAutoReviewActionContext();
    const pending = new Map<string, { cancel(): void; modeChanged?(): void }>();
    const stallTimeoutMs = resolveAgyStallTimeoutMs(opts.vendorOptions?.agyStallTimeoutMs, this.deps.agyStallTimeoutMs);
    const emit = (event: AgentEvent) => {
      if (!closed) queue.push({ ...event, source: 'agy', turnAttemptToken: turnOptions?.turnAttemptToken });
    };
    const wantsIsolation = !this.deps.createAgyTransport || this.deps.agySandbox !== undefined;
    // Non-Linux hosts (Windows, macOS) have no bwrap/pasta. Only when the host explicitly allows it,
    // agy runs there without OS isolation: filtered env, a visible notice, no silent fallback.
    const unsandboxedByPlatform = wantsIsolation && process.platform !== 'linux'
      && this.deps.agySandbox?.allowWithoutSystemSandbox === true;
    const useSandbox = wantsIsolation && !unsandboxedByPlatform;
    // Full access follows the other engines (Codex danger-full-access): no file or network
    // isolation. The choice is fixed for this process; the host relaunches agy (resume) when the
    // mode later crosses this line, so `mode` here is the mode this process was started with.
    const fullAccessLaunch = useSandbox && mode === 'bypassPermissions';
    const sandboxStateRoot = this.deps.agySandbox?.stateRoot ?? path.join(os.homedir(), '.cindy', 'agy-sandbox', 'state');
    // agy sees the task folder by its real path inside the sandbox; a symlinked workingDir does not exist there.
    const agyWorkingDir = wantsIsolation ? realpathOr(opts.workingDir) : opts.workingDir;
    const translator = new AgyTranslator(emit, wantsIsolation && !fullAccessLaunch ? {
      taskDir: agyWorkingDir, homeDir: os.homedir(),
      visibleDirs: useSandbox
        ? agyPrivateStateMounts(sandboxStateRoot, os.homedir()).map(mount => mount.target)
        : [],
      locale: this.deps.uiLocale,
    } : undefined);
    // Host reads / lists / uploads of this folder go through checkAgyTaskPath (cindy#1 QQ 6924350879 item 5).
    // The folder is also recorded on disk and stays an agy task folder after close() (QQ B2 on #15);
    // close() only ends the in-memory entry. Throws, and agy does not start, if it cannot be recorded.
    let releaseTaskDir: (() => void) | undefined = registerAgyTaskDir(opts.workingDir);
    const uiLocale = this.deps.uiLocale;
    const emitReviewNotice = (message: string) => emit({ type: 'error', data: { message, isTerminal: false } });
    const reviewUnavailable = createAutoReviewUnavailableNotice(emitReviewNotice);
    const confirmUndelivered = createAutoReviewConfirmUndeliveredNotice(emitReviewNotice);
    const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
    const watchdog = new AgyStallWatchdog({
      stallTimeoutMs,
      onWarn: silent => {
        this.deps.logger.warn('agy turn silent', { silentMs: silent, stallTimeoutMs });
        emit({ type: 'status', data: { ...translator.usage, isRunning: true,
          status: `Waiting for agy: no events for ${seconds(silent)}`
            + (stallTimeoutMs > 0 ? ` (configured silence limit ${seconds(stallTimeoutMs)})` : '; still waiting, Stop remains available') } });
      },
      onStall: silent => { void onStall(silent); },
    });
    const reviewAutoAction = async (action: ReviewableAction) => {
      if (closed || fenced || cancelled || !running) {
        return { verdict: 'block' as const, reason: 'agy has no active authorized turn.' };
      }
      const intent = userIntent;
      const generation = permissionGeneration;
      const request = { sessionId: opts.sessionId, agentKind: 'agy' as const, providerId: opts.providerId,
        model, userIntent: intent, precedingBlockedActions: actionContext.precedingBlockedActions,
        action, workspaceRoots: [agyWorkingDir], writableRoots: [agyWorkingDir], platform: process.platform };
      const decision = await withAutoReviewContext(request, this.deps.reviewAutoPermissionAction,
        prepared => resolveAutoReviewDecision(prepared, this.deps.reviewAutoPermissionAction));
      if (closed || fenced || cancelled || !running || intent !== userIntent
        || generation !== permissionGeneration || model !== request.model) {
        return { verdict: 'block' as const, reason: 'agy authorization changed; retry against the current request.' };
      }
      actionContext.record(action, decision);
      return decision;
    };
    const clearInteractions = () => {
      for (const interaction of pending.values()) interaction.cancel();
      pending.clear();
    };
    const interact = async (request: InteractionRequest, action?: ReviewableAction): Promise<InteractionDecision | undefined> => {
      if (closed || fenced || cancelled) return undefined;
      // Waiting for the user is not agy silence.
      const resume = watchdog.pause();
      return new Promise<InteractionDecision | undefined>(resolve => {
        let settled = false;
        let offered = false;
        let attempt = 0;
        const finish = (decision?: InteractionDecision) => {
          if (settled) return;
          settled = true;
          attempt++;
          pending.delete(request.requestId);
          if (offered) emit({ type: 'interaction_dismissed', data: { requestId: request.requestId, reason: decision ? 'resolved' : 'cancelled' } });
          resolve(decision);
        };
        const decide = async () => {
          const token = ++attempt;
          if (offered) {
            offered = false;
            emit({ type: 'interaction_dismissed', data: { requestId: request.requestId, reason: 'permission_mode_changed' } });
          }
          if (settled || closed || fenced || cancelled) { finish(); return; }
          let displayRequest = request;
          let unavailable = false;
          if (request.kind === 'permission' && action) {
            // Existing Cindy permission-mode semantics, identical to the other harnesses.
            if (mode === 'bypassPermissions') { finish({ kind: 'permission', behavior: 'allow' }); return; }
            if (mode === 'auto') {
              const decision = await reviewAutoAction(action);
              if (settled || token !== attempt) return;
              if (closed || fenced || cancelled) { finish(); return; }
              if (decision.verdict !== 'ask') {
                finish({ kind: 'permission', behavior: decision.verdict === 'allow' ? 'allow' : 'deny', reason: decision.reason });
                return;
              }
              unavailable = decision.unavailable === true;
              if (unavailable) { reviewUnavailable.notify(); displayRequest = annotatePermissionRequestForUnavailableReview(request); }
            }
          }
          if (!resolver) { if (unavailable) confirmUndelivered.notify(); finish(); return; }
          offered = true;
          emit({ type: 'interaction_request', data: displayRequest });
          Promise.resolve().then(() => resolver!(displayRequest)).then(decision => {
            if (settled || token !== attempt) return;
            if (unavailable && decision.kind === 'permission' && decision.behavior === 'deny'
              && isSystemPermissionDenialReason(decision.reason)) confirmUndelivered.notify();
            finish(decision);
          }, () => { if (!settled && token === attempt) { if (unavailable) confirmUndelivered.notify(); finish(); } });
        };
        pending.set(request.requestId, { cancel: () => finish(),
          ...(request.kind === 'permission' ? { modeChanged: () => { void decide(); } } : {}) });
        void decide();
      }).finally(resume);
    };
    const onRequest = async (method: string, raw: unknown): Promise<unknown> => {
      if (method !== 'session/request_permission') throw new AcpRpcError(-32601, `Unsupported ACP method: ${method}`);
      const params = record(raw);
      const cancelledResult = { outcome: { outcome: 'cancelled' } };
      if (closed || loading || cancelled || !running) return cancelledResult;
      if (typeof params.sessionId === 'string' && params.sessionId !== sessionId) return cancelledResult;
      watchdog.touch();
      const patch = record(params.toolCall);
      const tool = { ...translator.tool(patch.toolCallId), ...patch };
      const decision = await interact({ kind: 'permission', requestId: `agy:${randomUUID()}`,
        toolUseId: typeof tool.toolCallId === 'string' ? tool.toolCallId : undefined,
        toolName: agyToolName(tool), input: agyToolInput(tool),
        title: typeof tool.title === 'string' ? tool.title : undefined,
      }, agyReviewAction(tool, agyWorkingDir));
      if (!decision || cancelled || closed) return cancelledResult;
      const allow = decision.kind === 'permission' && decision.behavior === 'allow';
      const options = Array.isArray(params.options) ? params.options.map(record) : [];
      // allow_always would write a persistent native grant. Cindy approval is per request only.
      const option = options.find(item => item.kind === (allow ? 'allow_once' : 'reject_once'));
      return typeof option?.optionId === 'string'
        ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelledResult;
    };
    const updateCatalog = (raw: unknown) => {
      sessionState = { ...sessionState, ...record(raw) };
      const catalog = readAgyCatalog(sessionState);
      this.capabilities.availableModels = catalog.models;
      this.capabilities.switchModel = catalog.models.length ? yes : no;
      this.capabilities.effort = catalog.currentEfforts.length ? yes : no;
      this.capabilities.effortLevels = catalog.currentEfforts.map(id => ({ id, displayName: id }));
      this.capabilities.planMode = catalog.modes.includes(AGY_PLAN_MODE) ? yes : no;
    };
    const control = async (method: string, params: unknown, signal?: AbortSignal) => {
      if (fenced || closed || configuring) throw new Error('agy session is closed or configuring');
      configuring = true;
      try { return await request(method, params, { timeoutMs: CONTROL_TIMEOUT, signal: signal ?? (this.startups.has(startup) ? startup.signal : undefined) }); }
      catch (error) {
        if (!(error instanceof AcpRpcError)) { fenced = true; await client!.close().catch(() => {}); }
        throw error;
      } finally { configuring = false; }
    };
    /** set_config_option with the returned configOptions as the receipt. */
    const setConfigOption = async (configId: string, value: string, signal?: AbortSignal) => {
      const current = readAgyCatalog(sessionState);
      const currentValue = configId === AGY_MODEL_CONFIG_ID ? current.currentModel
        : configId === AGY_EFFORT_CONFIG_ID ? current.currentEffort : current.currentMode;
      if (currentValue === value) return;
      const response = record(await control('session/set_config_option', { sessionId, configId, value }, signal));
      if (!Array.isArray(response.configOptions)) {
        throw new Error(`agy did not return a configuration receipt for ${configId}; the change is not confirmed`);
      }
      updateCatalog({ configOptions: response.configOptions });
      const after = (response.configOptions as unknown[]).map(record).find(item => item.id === configId);
      if (after?.currentValue !== value) {
        throw new Error(`agy did not apply ${configId}=${value} (receipt reports ${String(after?.currentValue ?? 'nothing')})`);
      }
    };
    const setEffort = async (effort: Effort) => {
      if (fenced || closed || configuring) throw new Error('agy session is closed or configuring');
      if (running) throw new Error('Cannot change agy thinking level during an active turn');
      const catalog = readAgyCatalog(sessionState);
      if (!catalog.currentEfforts.includes(effort)) {
        throw new NotSupportedError('effort', { supported: false, reason: 'sdk-missing' });
      }
      await setConfigOption(AGY_EFFORT_CONFIG_ID, effort);
      wantedEffort = effort;
    };
    const setModel = async (next: string, options?: { effort?: Effort }) => {
      if (fenced || closed || configuring) throw new Error('agy session is closed or configuring');
      if (running) throw new Error('Cannot change agy model during an active turn');
      const catalog = readAgyCatalog(sessionState);
      assertAgyModelAllowed(next, allowedModels);
      if (!catalog.models.some(item => item.id === next)) {
        throw new NotSupportedError('setModel', { supported: false, reason: 'sdk-missing', upstreamRef: `agy has no model "${next}"` });
      }
      await setConfigOption(AGY_MODEL_CONFIG_ID, next);
      wantedModel = next;
      model = readAgyCatalog(sessionState).currentModel ?? next;
      // A model without thought levels clears the previous effort request.
      if (!readAgyCatalog(sessionState).currentEfforts.length) wantedEffort = undefined;
      if (options?.effort) await setEffort(options.effort);
    };
    const setPlanMode = async (enabled: boolean, preparing = false) => {
      if (fenced || closed || configuring) throw new Error('agy session is closed or configuring');
      if (running && !preparing) throw new Error('Cannot change agy mode during an active turn');
      const catalog = readAgyCatalog(sessionState);
      const target = enabled ? AGY_PLAN_MODE : AGY_DEFAULT_MODE;
      if (!enabled && !catalog.modes.length) { wantedPlan = false; return; }
      if (!catalog.modes.includes(target)) throw new NotSupportedError('setPlanMode', { supported: false, reason: 'sdk-missing' });
      const was = catalog.currentMode === AGY_PLAN_MODE;
      await setConfigOption(AGY_MODE_CONFIG_ID, target, preparing ? preparingController?.signal : undefined);
      wantedPlan = enabled;
      if (was !== enabled) emit({ type: 'plan_mode_changed', data: { enabled } });
    };
    /** The receipt gate: block a send when agy's reported configuration is not what the task asked for. */
    const assertReceipts = () => {
      const catalog = readAgyCatalog(sessionState);
      assertAgyModelAllowed(wantedModel, allowedModels);
      if (catalog.currentModel !== wantedModel) {
        throw new Error(`agy reports model "${catalog.currentModel ?? 'unknown'}" but this task requested "${wantedModel}"; send blocked. Choose the model again to re-apply it.`);
      }
      if (wantedEffort && catalog.currentEfforts.length && catalog.currentEffort !== wantedEffort) {
        throw new Error(`agy reports thinking level "${catalog.currentEffort ?? 'unknown'}" but this task requested "${wantedEffort}"; send blocked.`);
      }
      const expectedMode = wantedPlan ? AGY_PLAN_MODE : AGY_DEFAULT_MODE;
      if (catalog.currentMode !== undefined && catalog.currentMode !== expectedMode) {
        throw new Error(`agy reports mode "${catalog.currentMode}" but Cindy expects "${expectedMode}"; send blocked so agy cannot approve its own actions.`);
      }
    };
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      fenced = true;
      watchdog.stop();
      closePromise = (async () => {
        cancelled = true;
        preparingController?.abort();
        clearInteractions();
        if (running && sessionId) await client?.notify('session/cancel', { sessionId }).catch(() => {});
        await client?.close();
        await active?.catch(() => {});
        releaseTaskDir?.(); releaseTaskDir = undefined;
        try { disposeMcp?.(); } catch { /* the bridge lease is best-effort on close */ } disposeMcp = undefined;
        if (!closed) queue.end();
        closed = true;
        running = false;
        active = undefined;
        if (handle) this.sessions.delete(handle);
      })().catch(error => { closePromise = undefined; throw error; });
      return closePromise;
    };
    /** Ask agy to cancel, and fence the process if it does not confirm in time. */
    const cancelTurn = async () => {
      cancelled = true;
      preparingController?.abort();
      clearInteractions();
      await client!.notify('session/cancel', { sessionId }).catch(() => {});
      const current = active;
      if (!current) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([current.catch(() => {}), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('agy did not confirm cancellation')), CANCEL_TIMEOUT);
        })]);
      } catch {
        // A missing acknowledgement never means idle; never run a second turn beside it.
        await close();
      } finally { if (timer) clearTimeout(timer); }
    };
    const onStall = async (silent: number) => {
      if (!running || closed || fenced) return;
      stalled = true;
      this.deps.logger.warn('agy turn stalled; cancelling', { silentMs: silent, stallTimeoutMs });
      await cancelTurn();
    };
    let handle: AgentSessionHandle | undefined;
    try {
      assertCurrent();
      assertAgyModelAllowed(requestedModel, allowedModels);
      // Where agy runs without system isolation (Windows, macOS, Full access) it already reaches
      // every folder the user can, so a teammate's own folders and the Library need no grant (and
      // read-only cannot be enforced there, as for any agy task). Inside the Linux sandbox they
      // would be silently unreachable, so that case is refused.
      const directoryGrantsEnforced = useSandbox && !fullAccessLaunch;
      if (directoryGrantsEnforced && (opts[LIBRARY_READ_ROOT] || opts.extraDirs?.length || opts.writableDirs?.length)) {
        throw new Error('agy ACP cannot enforce additional directory grants or a read-only Library root');
      }
      if (opts.reviewMode) throw new Error('agy ACP does not support the restricted Reviewer runtime');
      // A teammate works in its own folders under the home directory, which the sandbox hides.
      if (opts.botRuntimeProfile && directoryGrantsEnforced) {
        throw new Error('agy teammates cannot reach their own folders inside the Linux sandbox yet; use Full access');
      }
      if (opts.remoteHostId || opts.deviceHosted) throw new Error('agy currently runs only on the task host computer');
      if (!path.isAbsolute(opts.workingDir)) throw new Error('agy ACP requires an absolute working directory');
      if (!this.capabilities.permissionModes.some(option => option.id === mode)) throw new NotSupportedError('permissionMode', no);
      const authEnv = await this.deps.auth.getAuthEnv();
      const env = { ...process.env, ...authEnv };
      const memoryEnabled = (opts.makerMemoryEnabled ?? this.deps.runtimeConfig.makerMemoryEnabled) === true;
      {
        const scope = await resolveMemoryScopeKey(opts.makerMemoryScopeKey ?? opts.workingDir);
        const memory = memoryEnabled ? opts.makerMemoryIndexSnapshot
          ?? (this.deps.makerMemory ? await (await this.deps.makerMemory.getStore(scope)).getIndex() : '') : '';
        // ACP has no system-message API. Pass caller-owned context once with the first user prompt.
        // A classic teammate has its own identity and does not inherit the owner's user prompt.
        const ownerPrompt = isolatedBotProfile(opts.botRuntimeProfile) ? undefined : opts.userPrompt;
        context = [opts.botProfilePrompt, opts.botProfileContextPrompt, memory, opts.botUserProfilePrompt, ownerPrompt].filter(Boolean).join('\n\n');
      }
      assertCurrent();
      // System-level isolation: agy only touches the task folder and its private state; no host
      // loopback, no session bus (cindy#1 6908586833, 6909268027). Fails closed, never runs bare.
      if (unsandboxedByPlatform) {
        emit({ type: 'error', data: { message: agyNoSystemIsolationText(this.deps.uiLocale), isTerminal: false } });
      }
      // Cindy's own tools (memory, helper, plugins...) are served by the host's loopback MCP
      // bridge, the same per-session bridge Pi uses. Inside the Linux sandbox only the bridge's
      // own port is forwarded (see hostLoopbackPorts); the rest of host loopback stays closed.
      if (opts.sessionId && this.deps.preparePiExtraSpawnConfig) {
        try {
          const extra = await this.deps.preparePiExtraSpawnConfig(this.deps.mcpProviders ?? [], {
            agentKind: 'agy',
            sessionId: opts.sessionId,
            ...(opts.sessionInstanceId ? { sessionInstanceId: opts.sessionInstanceId } : {}),
            workingDir: agyWorkingDir,
            ...(opts.makerMemoryScopeKey ? { memoryScopeKey: opts.makerMemoryScopeKey } : {}),
            memoryEnabled: (opts.makerMemoryEnabled ?? this.deps.runtimeConfig.makerMemoryEnabled) === true,
            // The teammate's allowed tool servers; without it a teammate would get every server.
            ...(isolatedBotProfile(opts.botRuntimeProfile)?.mcpPolicy
              ? { botMcpPolicy: isolatedBotProfile(opts.botRuntimeProfile)!.mcpPolicy } : {}),
            vendorOptions: { ...(opts.vendorOptions ?? {}) },
            mcpCallerKind: 'root',
            mcpCallerAttested: true,
          });
          disposeMcp = extra?.disposeSessionCtx;
          const bridge = extra?.mcpBridge;
          if (bridge?.token) {
            mcpServers = bridge.servers.filter(server => !server.remote && bridgeLoopbackPort(server.url) !== undefined).map(server => ({
              type: 'http', name: server.name, url: server.url,
              headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }],
            }));
          }
        } catch (error) {
          // Tools are an addition: a bridge that cannot start must not stop the task.
          this.deps.logger.warn('agy: Cindy MCP bridge is unavailable; starting without Cindy tools', { error: String(error) });
        }
        assertCurrent();
      }
      // The CLI serves HTTP MCP only when each session has its own worker process.
      const acpArgs = mcpServers.length ? [...AGY_ACP_ARGS, '--process-per-session'] : [...AGY_ACP_ARGS];
      const launch = fullAccessLaunch
        ? await prepareAgyFullAccessLaunch({ binaryPath: this.deps.binaryPath, args: acpArgs, taskDir: agyWorkingDir,
          homeDir: os.homedir(), stateRoot: sandboxStateRoot, env, passEnvKeys: Object.keys(authEnv), probe: this.deps.agySandbox?.probe,
          shareCliLogin: this.deps.agySandbox?.shareCliLogin === true })
        : useSandbox
        ? await prepareAgySandboxedLaunch({ binaryPath: this.deps.binaryPath, args: acpArgs, taskDir: agyWorkingDir,
          hostLoopbackPorts: [...new Set(mcpServers.map(server => bridgeLoopbackPort(server.url)!))],
          homeDir: os.homedir(), stateRoot: sandboxStateRoot, env, passEnvKeys: Object.keys(authEnv), probe: this.deps.agySandbox?.probe,
          shareCliLogin: this.deps.agySandbox?.shareCliLogin === true })
        : { command: this.deps.binaryPath, args: acpArgs,
            // issue #13: the branch that runs without the sandbox must never hand agy the full
            // process env. On the test-transport seam it stays exactly as before.
            env: unsandboxedByPlatform
              ? filterAgyUnsandboxedEnv(env, os.homedir(), agyWorkingDir, Object.keys(authEnv))
              : env };
      if (!this.deps.skipAgyBinaryPreflight) {
        const version = await this.checkLaunchVersion(this.deps.binaryPath, launch, acpArgs.length, agyWorkingDir,
          fullAccessLaunch ? 'full' : useSandbox ? 'sandbox' : 'host');
        this.deps.logger.debug('agy binary accepted', { version });
      }
      assertCurrent();
      const transport = (this.deps.createAgyTransport ?? spawnAcpTransport)({ binaryPath: launch.command, args: launch.args, cwd: agyWorkingDir, env: launch.env });
      client = new AcpClient(transport, {
        requestTimeoutMs: CONTROL_TIMEOUT, onRequest,
        onNotification: (method, raw) => {
          const params = record(raw);
          if (method !== 'session/update' || params.sessionId !== sessionId) return;
          // Any update for this session — text, thoughts, tools, usage, config — is liveness.
          if (running) watchdog.touch();
          const update = record(params.update);
          if (update.sessionUpdate === 'config_option_update') updateCatalog({ configOptions: update.configOptions });
          else if (update.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
            const configs = Array.isArray(sessionState.configOptions) ? sessionState.configOptions : [];
            updateCatalog({ configOptions: configs.map(item => record(item).id === AGY_MODE_CONFIG_ID ? { ...record(item), currentValue: update.currentModeId } : item) });
          }
          if (running && !loading) translator.update(update);
        },
        onClose: () => {
          clearInteractions();
          watchdog.stop();
          if (!loading && !running && !fenced && !closed) {
            fenced = true;
            emit({ type: 'error', data: { message: 'Antigravity CLI (agy) exited. Reopen this task to resume.', isTerminal: true, reason: 'agy_acp_disconnected' } });
          }
        },
      });
      const init = record(await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'cindy', version: '1.0.0' },
      }, { signal: startup.signal }));
      if (init.protocolVersion !== 1) throw new Error('agy ACP protocol version is unsupported');
      const capabilities = record(init.agentCapabilities);
      promptCapabilities = record(capabilities.promptCapabilities);
      this.capabilities.multimodal.image = promptCapabilities.image === true ? yes : no;
      // The CLI can append to its system prompt. Caller-owned context (teammate persona, memory
      // index, the user's prompt) then applies to every turn and to a resumed session, instead of
      // riding once on the first user message.
      const systemAppend = record(record(record(capabilities._meta).antigravity).systemPrompt).append === true && context
        ? { _meta: { antigravity: { systemPrompt: { append: context } } } } : {};
      if ('_meta' in systemAppend) context = '';
      // Cindy never starts an interactive sign-in from a task; see AgentNotAuthenticatedError below.
      if (opts.resumeSessionId) {
        validateSessionId(opts.resumeSessionId);
        sessionId = opts.resumeSessionId;
        const sessionCaps = record(capabilities.sessionCapabilities);
        // Prefer resume (no history replay); session/load replays history, which is suppressed while loading.
        if (sessionCaps.resume !== undefined) {
          updateCatalog(await request('session/resume', { sessionId, cwd: agyWorkingDir, mcpServers, ...systemAppend }, { signal: startup.signal }));
        } else if (capabilities.loadSession === true) {
          updateCatalog(await request('session/load', { sessionId, cwd: agyWorkingDir, mcpServers, ...systemAppend }, { signal: startup.signal }));
        } else throw new Error('This agy version cannot resume saved tasks');
      } else {
        const result = record(await request('session/new', { cwd: agyWorkingDir, mcpServers, ...systemAppend }, { signal: startup.signal }));
        sessionId = validateSessionId(result.sessionId);
        updateCatalog(result);
      }
      loading = false;
      if (wantedModel) await setModel(wantedModel);
      model = readAgyCatalog(sessionState).currentModel ?? model;
      if (wantedEffort) {
        if (!readAgyCatalog(sessionState).currentEfforts.length) {
          // The chosen model has no thought levels in agy (e.g. gpt-oss); an effort cannot be honored.
          if (opts.effort) this.deps.logger.debug('agy model has no thinking levels; effort ignored', { model });
          wantedEffort = undefined;
        } else await setEffort(wantedEffort);
      }
      // Pin the native mode: never inherit accept-edits/auto from agy settings.
      await setPlanMode(wantedPlan);
      assertReceipts();
      emit({ type: 'session_id', data: sessionId });
      if (wantedPlan) emit({ type: 'plan_mode_changed', data: { enabled: true } });
      const validateSend = (options: SendOptions = {}) => {
        if (closed || fenced) throw new Error('agy session is closed');
        if (running || configuring) throw new Error('agy already has an active turn or configuration');
        if (options.signal?.aborted) throw new Error('agy send cancelled before dispatch');
        if (options[PINNED_SKILL_INVOCATION]) throw new Error('agy ACP cannot enforce a pinned Skill identity');
        if (options.toolsDisabled) throw new Error('agy ACP cannot guarantee a tools-disabled turn');
        if (options.turnPermissionPolicy) throw new TurnPermissionPolicyUnsupportedError('agy', mode);
      };
      const finishTurn = () => {
        running = false;
        active = undefined;
        watchdog.stop();
        clearInteractions();
      };
      handle = {
        id: sessionId, agentKind: 'agy', get model() { return model; },
        events: () => queue,
        getUsageSnapshot: () => ({ ...translator.usage }),
        setInteractionResolver: next => { resolver = next; },
        reviewAutoPermissionAction: reviewAutoAction,
        validateSendOptions: validateSend,
        isTurnRunning: () => running,
        async send(message: UserMessage, options: SendOptions = {}) {
          validateSend(options);
          running = true;
          cancelled = false;
          stalled = false;
          turnOptions = options;
          translator.beginTurn();
          preparingController = new AbortController();
          const signalAbort = () => { cancelled = true; preparingController?.abort(); };
          options.signal?.addEventListener('abort', signalAbort, { once: true });
          try {
            if (options.planMode !== undefined) await setPlanMode(options.planMode, true);
            assertReceipts();
            const blocks = await promptBlocks(message, promptCapabilities, { taskDir: agyWorkingDir, locale: uiLocale?.() });
            if (closed || cancelled || options.signal?.aborted) throw new Error('agy send cancelled before dispatch');
            const nextIntent = appendAutoReviewUserIntent(firstPrompt ? undefined : userIntent, message.content, options);
            actionContext.advance(typeof nextIntent !== 'string');
            userIntent = normalizeAutoReviewUserIntent(nextIntent);
            reviewUnavailable.reset(); confirmUndelivered.reset();
            if (firstPrompt && context) blocks.unshift({ type: 'text', text: context });
            emit({ type: 'status', data: { ...translator.usage, isRunning: true, status: 'Working' } });
            // session/prompt resolves only at the end of the turn; never await it from send().
            // Recheck after asynchronous attachment preparation, immediately before the write.
            assertReceipts();
            active = request('session/prompt', { sessionId, prompt: blocks }, { timeoutMs: PROMPT_REQUEST_TIMEOUT });
            watchdog.start();
            firstPrompt = false;
            preparingController = undefined;
            options.signal?.removeEventListener('abort', signalAbort);
            active.then(async result => {
              const response = record(result);
              if (!STOP_REASONS.includes(String(response.stopReason))) {
                fenced = true;
                watchdog.stop();
                try { await client!.close(); } catch {
                  emit({ type: 'error', data: { message: 'agy process stop is not confirmed. Retry closing this task.', isTerminal: false, reason: 'agy_cleanup_pending' } });
                  return;
                }
                finishTurn();
                emit({ type: 'error', data: { message: 'agy returned an invalid prompt result', isTerminal: true, reason: 'agy_invalid_prompt_result' } });
                turnOptions = undefined;
                return;
              }
              translator.finishTurn(response.usage);
              finishTurn();
              if (stalled) {
                emit({ type: 'error', data: { message: stallMessage(stallTimeoutMs), isTerminal: true, reason: 'agy_stall_timeout' } });
              } else if (!closed) {
                emit({ type: 'done', data: { ...translator.usage, stopReason: response.stopReason, cancelled: response.stopReason === 'cancelled' } });
              }
              turnOptions = undefined;
            }, async error => {
              // Classify before fencing: fencing marks the turn cancelled.
              const userCancelled = cancelled && !stalled;
              // A transport failure/timeout is not proof the native turn stopped.
              if (!(error instanceof AcpRpcError)) {
                fenced = true;
                cancelled = true;
                clearInteractions();
                watchdog.stop();
                try { await client!.close(); } catch {
                  emit({ type: 'error', data: { message: 'agy process stop is not confirmed. Retry closing this task.', isTerminal: false, reason: 'agy_cleanup_pending' } });
                  return;
                }
              }
              finishTurn();
              if (!closed) {
                if (isAuthError(error)) {
                  emit({ type: 'error', data: { message: AGY_SIGN_IN_MESSAGE, isTerminal: true, reason: 'agy_not_authenticated' } });
                } else {
                  emit({ type: 'error', data: {
                    message: stalled ? stallMessage(stallTimeoutMs)
                      : userCancelled ? 'agy turn cancelled'
                      : error instanceof AcpRpcError ? safeError(error)
                        : `Antigravity CLI (agy) stopped unexpectedly during this turn${stderrHint(client)}. Reopen this task to resume.`,
                    isTerminal: true,
                    reason: stalled ? 'agy_stall_timeout' : userCancelled ? 'agy_cancelled' : error instanceof AcpRpcError ? 'agy_acp_error' : 'agy_acp_disconnected' } });
                }
              }
              turnOptions = undefined;
            });
          } catch (error) {
            preparingController = undefined;
            options.signal?.removeEventListener('abort', signalAbort);
            running = false;
            turnOptions = undefined;
            throw error;
          }
        },
        async steer() { throw new NotSupportedError('sameTurnSteer', no); },
        async abort() {
          if (fenced) { await close(); return; }
          if (!running) return;
          await cancelTurn();
        },
        close,
        setModel,
        setEffort,
        getEffort: () => readAgyCatalog(sessionState).currentEffort ?? null,
        async setPermissionMode(next) {
          if (closed || fenced) throw new Error('agy session is closed');
          if (!['ask', 'default', 'auto', 'bypassPermissions'].includes(next)) throw new NotSupportedError('permissionMode', no);
          if (mode === next) return;
          mode = next;
          permissionGeneration++;
          reviewUnavailable.reset(); confirmUndelivered.reset();
          for (const interaction of pending.values()) interaction.modeChanged?.();
        },
        setPlanMode: (enabled: boolean) => setPlanMode(enabled),
        getPlanMode: () => readAgyCatalog(sessionState).currentMode === AGY_PLAN_MODE,
        getExecutionPlanMode: () => readAgyCatalog(sessionState).currentMode === AGY_PLAN_MODE,
      };
      assertCurrent();
      this.sessions.add(handle);
      return handle;
    } catch (error) {
      try {
        await close();
      } catch {
        let confirmStopped!: () => void;
        const whenStopped = new Promise<void>(resolve => { confirmStopped = resolve; });
        const pendingError = new AgentStartupCleanupPendingError('agy startup cleanup has not confirmed process exit', { cause: error, whenStopped });
        this.failedStartupCleanups.set(cleanupKey, { close, pendingError, confirmStopped });
        throw pendingError;
      }
      if (error instanceof AgentNotAuthenticatedError) throw error;
      if (isAuthError(error)) throw new AgentNotAuthenticatedError('agy', AGY_SIGN_IN_MESSAGE);
      if (error instanceof AgyBinaryUnavailableError) throw new AgentStartupStoppedError(error);
      if (error instanceof AgySandboxUnavailableError) throw new AgentStartupStoppedError(new Error(agySandboxUnavailableText(error)));
      if (!(error instanceof AcpRpcError) && !(error instanceof NotSupportedError) && client) {
        const hint = stderrHint(client);
        if (hint) throw new AgentStartupStoppedError(new Error(`${error instanceof Error ? error.message : String(error)}${hint}`));
      }
      throw new AgentStartupStoppedError(error instanceof AcpRpcError ? new AcpRpcError(error.code, safeError(error)) : error);
    }
  }
}

function realpathOr(dir: string): string {
  try { return realpathSync(dir); } catch { return dir; }
}

/**
 * `[agy_no_system_isolation]` notice, emitted once per start on hosts without bwrap/pasta.
 * Says exactly what is and is not protected; JJ's final wording pending (cindy#1).
 */
export function agyNoSystemIsolationText(locale?: () => string | null | undefined): string {
  const language = locale?.() ?? '';
  if (/^zh\b|^zh-/i.test(language) || language === 'zh-CN' || language === 'zh-TW') {
    return '[agy_no_system_isolation] 这台电脑上没有系统级文件隔离，Antigravity 能碰到你这个账户能碰到的文件，只能靠它在动之前先向你申请来限制范围。任务文件夹以外的请求，请看清楚再同意。';
  }
  return '[agy_no_system_isolation] This computer has no system-level file isolation: Antigravity can reach any file your account can, limited only by asking you first. Read requests outside this task folder before you allow them.';
}

/** `[agy_sandbox_unavailable]` code + English fallback; zh/en wording pending JJ (cindy#1). */
function agySandboxUnavailableText(error: AgySandboxUnavailableError): string {
  const copy = AGY_SANDBOX_USER_COPY_DRAFT.unavailable;
  return `[agy_sandbox_unavailable] ${copy.en.replace('{reason}', copy.reason[error.reason].en)} (${error.detail})`;
}

const AGY_SIGN_IN_MESSAGE = 'The Antigravity ACP session requires authentication. Check the CLI authentication environment; this does not establish that the local login has expired.';

function stallMessage(limitMs: number): string {
  return `agy reached the configured no-event limit of ${Math.round(limitMs / 1000)}s and was cancelled. `
    + 'Retry, or raise the limit with the CINDY_AGY_STALL_TIMEOUT_MS setting (0 disables it).';
}

/** ACP reserves -32000 for auth_required. */
function isAuthError(error: unknown): boolean {
  if (!(error instanceof AcpRpcError)) return false;
  return error.code === -32000 || /\b(auth(entication)? required|not (signed|logged) in|unauthenticated|login required)\b/i.test(error.message);
}

function stderrHint(client: AcpClient | undefined): string {
  const tail = client?.getStderrTail().trim();
  if (!tail) return '';
  const line = redactSensitiveText(tail.split('\n').filter(Boolean).pop() ?? '').slice(0, 200);
  return line ? ` (agy: ${line})` : '';
}

function validateSessionId(id: unknown): string {
  if (typeof id !== 'string' || !id.trim() || id.length > 4096 || [...id].some(char => char.charCodeAt(0) < 32)) {
    throw new Error('agy ACP returned an invalid session identity');
  }
  return id;
}

function safeError(error: unknown): string {
  // Native errors can contain request payloads/tokens. Never reflect arbitrary error.data.
  return error instanceof Error ? redactSensitiveText(error.message).slice(0, 500) : 'agy ACP request failed';
}

async function promptBlocks(message: UserMessage, capabilities: AcpRecord,
  guard: { taskDir: string; locale?: string | null }): Promise<AcpRecord[]> {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  const blocks: AcpRecord[] = [];
  for (const item of message.content) {
    if (item.type === 'text') blocks.push({ type: 'text', text: item.text });
    else if (item.type === 'image') {
      if (capabilities.image !== true) throw new Error('This agy version does not support image input');
      // An image from the task folder goes through the same real-path check as every other host read.
      const { handle: file } = await openAgyTaskFile(item.path, guard);
      let bytes: Buffer;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('agy image input must be a regular file of at most 10 MiB');
        bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!result.bytesRead) throw new Error('agy image input changed while reading');
          offset += result.bytesRead;
        }
      } finally { await file.close(); }
      blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType: item.mimeType ?? 'image/png' });
    } else {
      const name = item.type === 'mention' ? item.name : path.basename(item.path);
      if (capabilities.embeddedContext === true) blocks.push({ type: 'resource_link', name, uri: pathToFileURL(item.path).href });
      else blocks.push({ type: 'text', text: `${name}: ${item.path}` });
    }
  }
  return blocks;
}
