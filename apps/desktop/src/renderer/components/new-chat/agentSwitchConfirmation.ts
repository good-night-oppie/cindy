import type { ConfirmOptions } from '@/components/ui/confirm-dialog-provider';
import { agySwitchPermissionChange, permissionModeAfterSwitchToAgy } from '../../../shared/agentKindConversion';
import { isProviderShareAgentDeviceId } from '../../../shared/providerShare';

/**
 * 隐藏的本地用户 override（规则 20）：键缺失 = 系统默认“显示确认”；用户勾选
 * “下次不再提醒”并确认后，ConfirmDialogProvider 会写入显式 override。删除对应
 * `confirm-dialog.skip:*` localStorage 键即可恢复当前版本默认值，不固化默认快照。
 */
export const AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY = 'new-chat.agent-switch.handoff-risk.v1';

export interface AgentSwitchConfirmationCopy {
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
  dontShowAgainLabel: string;
}

export interface ConfirmAgentSwitchRiskParams {
  /**
   * 「这一次不必再问」——**只有**本次目标就是会话正在跑的真实引擎时才为 true
   * (撤销 / 回原引擎:main 侧 same-engine no-op,不重建上下文)。
   *
   * 挂着的切换意图**不能**当作已经确认过(Chris 2026-08-20):Claude 任务里点了 Pi 收藏、
   * 意图挂上但还没发消息,再点另一条非当前引擎的模型/收藏,仍然是一次新的上下文重建,
   * 必须再问。判据只认 runtime,不认意图目标,详见 ChatInput 的调用点。
   */
  hasSwitchIntent: boolean;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  copy: AgentSwitchConfirmationCopy;
  /**
   * The switch will also change the task's permissions (entering Antigravity from Full access or
   * from a mode it does not have). The user is told every time: "Don't remind me again" covers
   * the handoff risk only, so the dialog is shown without that option and ignores a saved skip.
   */
  permissionNotice?: string;
}

/**
 * What the switch dialog says about permissions when a task enters Antigravity from another
 * engine: nothing when the mode is kept, otherwise the copy for the change the row commit makes.
 */
export function agySwitchPermissionNotice(
  targetAgent: string | null | undefined,
  runningAgent: string | null | undefined,
  permissionMode: string | null | undefined,
  t: (key: 'newChat.chatInput.agentSwitch.confirmation.antigravityFromFullAccess'
    | 'newChat.chatInput.agentSwitch.confirmation.antigravityFromUnsupported') => string,
): { permissionNotice?: string } {
  if (targetAgent !== 'agy' || runningAgent === 'agy') return {};
  const change = agySwitchPermissionChange(permissionMode);
  if (!change) return {};
  return { permissionNotice: t(change === 'fromFullAccess'
    ? 'newChat.chatInput.agentSwitch.confirmation.antigravityFromFullAccess'
    : 'newChat.chatInput.agentSwitch.confirmation.antigravityFromUnsupported') };
}

type AgySwitchPermissionChange = NonNullable<ReturnType<typeof agySwitchPermissionChange>>;

/** How the host reports a message it held because the pending switch's permission change is not agreed to. */
export const AGENT_SWITCH_PERMISSION_UNCONFIRMED_PREFIX = 'AGENT_SWITCH_PERMISSION_UNCONFIRMED:';

export function isAgentSwitchPermissionUnconfirmedError(error: string | null | undefined): boolean {
  return !!error && error.startsWith(AGENT_SWITCH_PERMISSION_UNCONFIRMED_PREFIX);
}

/**
 * What the user last agreed a pending switch into Antigravity would do to the task's permissions,
 * per task: which change they were told about (none, when the mode is kept) and the mode it ends
 * in. The switch is applied by a later send, and the mode can change in between; what was agreed
 * then no longer describes what the switch will do. Both parts are compared: Auto-review kept as
 * it is and Full access rewritten to Auto-review end in the same mode, but only one was announced.
 * Renderer memory only: a lost entry means the user is asked again, never that a change goes unannounced.
 */
const agreedAgySwitchPermissions = new Map<string, { change: AgySwitchPermissionChange | null; mode: string }>();

/** Record what the switch dialog (or its absence, when the mode is kept) told the user. */
export function noteAgySwitchPermissionAgreed(sessionId: string, permissionMode: string | null | undefined): void {
  agreedAgySwitchPermissions.set(sessionId, {
    change: agySwitchPermissionChange(permissionMode), mode: permissionModeAfterSwitchToAgy(permissionMode),
  });
}

/** What was agreed for this task's pending switch, to send to the host with the switch. */
export function readAgySwitchPermissionAgreed(sessionId: string): { change: AgySwitchPermissionChange | null; mode: string } | undefined {
  return agreedAgySwitchPermissions.get(sessionId);
}

/** The pending switch is gone (applied, withdrawn, or retargeted to another engine). */
export function forgetAgySwitchPermissionAgreed(sessionId: string): void {
  agreedAgySwitchPermissions.delete(sessionId);
}

/**
 * Whether the switch would rewrite this permission mode in a way the user has not agreed to. A
 * mode Antigravity keeps as it is needs no agreement: the user picked it themselves.
 */
export function agySwitchPermissionNeedsAgreement(sessionId: string, permissionMode: string | null | undefined): boolean {
  const change = agySwitchPermissionChange(permissionMode);
  if (!change) return false;
  const agreed = agreedAgySwitchPermissions.get(sessionId);
  return agreed?.change !== change || agreed.mode !== permissionModeAfterSwitchToAgy(permissionMode);
}

/**
 * The title of the dialog shown when a mode is picked in the permission menu while a switch into
 * Antigravity is pending. It names the mode the user just picked, with the label the menu showed
 * for it (the running engine's), not the mode the switch will turn it into; the body says that.
 */
export function agyPermissionChangeTitle(
  t: (key: string, options?: Record<string, unknown>) => string,
  runningAgent: string | null | undefined, pickedMode: string, displayName?: string,
): string {
  const mode = t(`newChat.permissionSelector.modes.${runningAgent ?? 'claude-code'}.${pickedMode}.label`, {
    defaultValue: displayName ?? pickedMode,
  });
  return t('newChat.chatInput.agentSwitch.permissionConfirmation.title', { mode });
}

/** Title per change, and the two buttons, of a dialog that asks again about a pending switch. */
export interface AgySwitchPermissionAgreementCopy {
  title: Record<AgySwitchPermissionChange, string>;
  /**
   * The statement of the change, where the shared one does not fit what the user just did. The
   * permission menu's dialog is shown before the picked mode is stored, so "the level you use
   * now" would name a level they are leaving; it says "the level you just picked" instead.
   */
  statement?: Partial<Record<AgySwitchPermissionChange, string>>;
  /** A paragraph after the statement of the change, for what confirming does not do. */
  note?: string;
  confirmText: string;
  cancelText: string;
}

/** The part of a pending switch, as the host reports it, that the agreement question is about. */
export interface AgySwitchPermissionPendingIntent {
  target: string;
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean | 'ultrafast';
  /** What the host has recorded as agreed; null when nothing; undefined when the host did not say. */
  agyPermissionAgreement?: { change: AgySwitchPermissionChange | null; mode: string } | null;
  /** Which registration this is, as the host stamped it; an agreement is sent back with it. */
  agyPermissionRevision?: number;
  configStaged?: true;
}

/**
 * Whether the task's pending switch into Antigravity would, applied to the stored mode now, be
 * refused by the host for want of an agreement. Unlike agySwitchPermissionNeedsAgreement this
 * goes by what the host has recorded, not by what this window remembers asking, so it is also
 * true after a reload, in another window, and for a switch nobody was asked about. A host that
 * did not report its record is not second-guessed. The partner exception is the host's own
 * (agySwitchPermissionIsGuarded).
 */
export function agySwitchPermissionAwaitsAgreement(input: {
  intent: AgySwitchPermissionPendingIntent | null | undefined;
  runningAgent: string | null | undefined;
  permissionMode: string | null | undefined;
  partnerConversation: boolean;
}): boolean {
  const { intent } = input;
  if (!intent || intent.target !== 'agy' || input.runningAgent === 'agy') return false;
  if (intent.agyPermissionAgreement === undefined) return false;
  if (intent.configStaged === true && input.partnerConversation) return false;
  const change = agySwitchPermissionChange(input.permissionMode);
  if (!change) return false;
  const agreed = intent.agyPermissionAgreement;
  return agreed?.change !== change || agreed.mode !== permissionModeAfterSwitchToAgy(input.permissionMode);
}

/**
 * The gate passed while a switch into Antigravity is pending, by a send and by a permission
 * change: when the switch would rewrite `permissionMode` in a way the user has not agreed to,
 * state the change that will actually happen and go on only if they agree. Resolves false when the
 * message must not be sent, or the permission must not be changed. The first pick of a Gemini
 * model keeps the switch dialog's own copy; this one names what the user is about to do.
 */
export async function confirmPendingAgySwitchPermission(input: {
  sessionId: string;
  intentTarget: string | null | undefined;
  runningAgent: string | null | undefined;
  permissionMode: string | null | undefined;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  copy: AgySwitchPermissionAgreementCopy;
  t: Parameters<typeof agySwitchPermissionNotice>[3];
}): Promise<boolean> {
  if (input.intentTarget !== 'agy' || input.runningAgent === 'agy') return true;
  if (!agySwitchPermissionNeedsAgreement(input.sessionId, input.permissionMode)) return true;
  const change = agySwitchPermissionChange(input.permissionMode)!;
  const statement = input.copy.statement?.[change]
    ?? agySwitchPermissionNotice('agy', input.runningAgent, input.permissionMode, input.t).permissionNotice;
  const agreed = await input.confirm({
    title: input.copy.title[change],
    description: input.copy.note ? `${statement}

${input.copy.note}` : statement,
    textClassName: input.copy.note ? 'select-none whitespace-pre-line' : 'select-none',
    confirmText: input.copy.confirmText,
    cancelText: input.copy.cancelText,
  });
  if (agreed) noteAgySwitchPermissionAgreed(input.sessionId, input.permissionMode);
  return agreed;
}

/**
 * The gate above, plus the host's copy. The host applies a pending switch from any entry and
 * refuses a rewrite it has not been told the user agreed to, so an agreement is registered with it
 * (attached to the switch the user was asked about) before the caller stores a mode or sends a
 * message. Resolves true when the caller may go on; rejects when the host could not be told.
 * Resolves false as well when the host answers that the switch asked about is no longer the
 * pending one: the answer was to a question that no longer stands, and nothing was recorded.
 */
export async function agreeToPendingAgySwitchPermission(input: {
  sessionId: string;
  intent: AgySwitchPermissionPendingIntent | null | undefined;
  runningAgent: string | null | undefined;
  permissionMode: string | null | undefined;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  copy: AgySwitchPermissionAgreementCopy;
  t: Parameters<typeof agySwitchPermissionNotice>[3];
  registerWithHost: (
    intent: AgySwitchPermissionPendingIntent,
    agreement: { change: AgySwitchPermissionChange | null; mode: string },
  ) => Promise<unknown>;
}): Promise<boolean> {
  const agreed = await confirmPendingAgySwitchPermission({
    sessionId: input.sessionId, intentTarget: input.intent?.target, runningAgent: input.runningAgent,
    permissionMode: input.permissionMode, confirm: input.confirm, copy: input.copy, t: input.t,
  });
  if (!agreed) return false;
  const pending = input.intent?.target === 'agy' && input.runningAgent !== 'agy' ? input.intent : null;
  const agreement = pending ? readAgySwitchPermissionAgreed(input.sessionId) : undefined;
  // Nothing to tell the host when the mode is kept as it is: it lets that through on its own.
  if (!pending || !agreement || agreement.change === null || !agySwitchPermissionChange(input.permissionMode)) return true;
  const answer = await input.registerWithHost(pending, agreement);
  if (answer && typeof answer === 'object'
    && (answer as { agyPermissionAgreementRecorded?: unknown }).agyPermissionAgreementRecorded === false) {
    forgetAgySwitchPermissionAgreed(input.sessionId);
    return false;
  }
  return true;
}

/**
 * Agent 切换确认门。
 *
 * 用户只要选的是**不是当前真实引擎**的模型或收藏,一律提示。返回原引擎(目标 = 会话
 * 真实引擎)放行 —— 那是 same-engine no-op,不重建上下文。挂着的意图不算已经确认过。
 */
export async function confirmAgentSwitchRisk({
  hasSwitchIntent,
  confirm,
  copy,
  permissionNotice,
}: ConfirmAgentSwitchRiskParams): Promise<boolean> {
  if (hasSwitchIntent) return true;

  if (permissionNotice) {
    return confirm({
      title: copy.title,
      description: `${permissionNotice}

${copy.description}`,
      textClassName: 'select-none whitespace-pre-line',
      confirmText: copy.confirmText,
      cancelText: copy.cancelText,
    });
  }

  return confirm({
    title: copy.title,
    description: copy.description,
    // 仅 Agent 切换风险文案禁选；其它 ConfirmDialog 仍保留复制能力。
    textClassName: 'select-none',
    confirmText: copy.confirmText,
    cancelText: copy.cancelText,
    dontShowAgainKey: AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY,
    dontShowAgainLabel: copy.dontShowAgainLabel,
  });
}

/**
 * 手动换电脑确认弹窗的说明文案 key(provider-groups.md §6.2):同引擎且来源、目标都不是分享时优先接续
 * 原生记录;跨引擎和分享中转只能走交接摘要。只决定文案;实际能否恢复仍由 sessionAgentSwitchHandler
 * 判定,失败时回退摘要。
 */
export function relocationDescriptionKey(input: {
  fromAgent: string | null | undefined;
  toAgent: string;
  fromAgentDeviceId: string | null | undefined;
  toAgentDeviceId: string | null | undefined;
}) {
  const keepsNativeHistory =
    input.fromAgent === input.toAgent &&
    !isProviderShareAgentDeviceId(input.fromAgentDeviceId) &&
    !isProviderShareAgentDeviceId(input.toAgentDeviceId);
  return keepsNativeHistory
    ? ('newChat.chatInput.agentRelocation.descriptionNativeHistory' as const)
    : ('newChat.chatInput.agentRelocation.description' as const);
}

export interface AgentSwitchResponseFreshness {
  /** 发起方已放弃(effect 清理:切走会话 / 换设备)。同步调用点传 false。 */
  cancelled: boolean;
  /** 发起时的本端写序号 vs 响应到达时的当前值(覆盖「已点选但尚未落 store」的窗口)。 */
  writeSeqAtStart: number;
  writeSeqNow: number;
  /** 发起时的意图修订号 vs 响应到达时的当前值(覆盖任何来源的实际变更)。 */
  intentRevAtStart: number;
  intentRevNow: number;
}

/**
 * device-link 远程会话的异步意图响应是否仍然新鲜(可以落到展示态)。两个调用点同构:
 * 打开 / 重连时的**权威意图读回**,以及切换 IPC 的**登记 ack**——两者都在 await 期间
 * 可能被更新的状态超车,落下去就会让选择器显示过期引擎,与被控端实际要执行的不一致。
 *
 * 判定必须基于**单调计数**,不能比较意图值本身:意图在途期间从 null 变成非空又清回
 * null(本端登记后撤销,或另一窗口 / 被控端经 sessions:patched 来回改)时,值与引用都会
 * 回到相等,过期响应就会被误判为新鲜。
 *
 * 两个计数各管一段:store 修订号覆盖**任何来源**的实际变更(含外部权威回流);本端写序号
 * 覆盖「用户已点选、切换 IPC 还在途、尚未落 store」的空窗。
 */
export function isAgentSwitchResponseFresh(args: AgentSwitchResponseFreshness): boolean {
  if (args.cancelled) return false;
  if (args.writeSeqNow !== args.writeSeqAtStart) return false;
  return args.intentRevNow === args.intentRevAtStart;
}

/** 切换 ack 到达后该做什么。 */
export type AgentSwitchAckAction =
  /** 登记乐观意图(deferred 常态路径)。 */
  | 'apply-intent'
  /** 同引擎 no-op:清掉展示意图,把这次点选当普通模型/来源切换应用到当前引擎。 */
  | 'same-engine-reselect'
  /** 立即切换已完成(harness / registry 缺省兜底),收敛真实引擎。 */
  | 'apply-switched'
  /** 已被更新的状态超车,本次 ack 作废。 */
  | 'discard';

/**
 * 切换 ack 的分派决策。三类判据作用域**不同**,不能一刀切:
 *
 * - **写序号**(本端点选)对所有分支生效:用户又点了一次,本次 ack 整体作废。
 * - **意图修订号**保护「要把本次选择写成乐观意图值」的分支(apply-intent /
 *   apply-switched):外部权威值更新,就不能用旧选择盖回去。deferred 分支另有一条
 *   `registeredIntentMatchesCurrent` 出口,专治**本次登记自己的广播回声**(见其字段说明)。
 * - 同引擎 no-op 不能从 renderer 的「修订号 + 最终值」猜因果：外部 set→clear ABA 与
 *   本次 clear 都会得到「修订号已变 + 当前为空」。新 host 因此返回 CAS 成功后的
 *   `sameEngineRevision`，后续 SET_MODEL 带回该 token 再做一次 CAS；若请求已在 host
 *   内被超车则返回 `sameEngineSuperseded` 直接丢弃。远程入口另由
 *   `supportsSessionAgentSwitchCas` 门控，不会向缺 token 的旧 host 开放；这里的无 token
 *   分支只作本地 harness / 防御性兼容，修订号变化时仍 fail-closed。
 */
/**
 * 回声匹配路径的**完整配置一致性**判据(2026-08-19 review P2 收口)。
 *
 * `registeredIntentMatchesCurrent` 刻意只比 target / model / providerId 三项(见下方字段
 * 说明):effort / fastMode 可能被 main 归一化,比它们会把合法回声误判成不匹配。但这留下
 * 一个缺口 —— device-link 往返期间,另一控制端**只改同一意图的 effort 或 Fast**(三元组
 * 不变)时,回声照样匹配,切换事务若据此报「完整成功」,面板会执行「成功才做」的持久化
 * 收尾(清 override / 提交・删除收藏编辑 / 写收藏锚点),把一份**并未实际应用**的本端配置
 * 当成了正在跑的那一份。
 *
 * 所以回声匹配之后还要补这一问:**权威快照里的 effort / Fast 是不是就是本端这次请求的
 * 值**。不一致 = 登记本身可能成功了,但本端的完整配置没有原样落地,调用方必须按
 * 「未完整应用」处理(不做任何破坏性收尾;意图展示与偏好同步照用权威值,那是另一条
 * 已收口的链路)。
 *
 * 宽严取向逐维写明(与偏好同步的「缺字段不写」同族,方向相反 —— 这里缺字段**放行**):
 * - 权威快照缺该维(`undefined`):main 对无档位模型不投影 effort、旧 host 不带 fastMode。
 *   缺 ≠ 被改,判不一致会把这类模型的每一次正常切换都误伤成失败 → 视为一致。
 * - 本端没请求 effort(空值):语义同 providerId 传 null —— 「跟随默认解析」,main 归一化
 *   出什么都是本次意图的一部分 → 视为一致。
 * - 两边都有值:逐字相等才一致。归一化分叉与外部超车在这里不可区分,也**不必**区分:
 *   两种情况下「本端请求的那份配置」都不是会话将要采用的配置,收尾都不该做。
 */
export function isAgentSwitchEchoConfigConsistent(args: {
  /** 回声匹配时 store 里的权威意图快照;非回声路径(常规新鲜 ack)传 null,恒一致。 */
  authoritative: { effort?: string; fastMode?: boolean | 'ultrafast' } | null;
  /** 本次请求解析后发出的 effort(空串 / undefined = 本端没指定,跟随默认解析)。 */
  requestedEffort: string | undefined;
  /** 本次请求解析后发出的 Fast。 */
  requestedFastMode: boolean | 'ultrafast';
}): boolean {
  const { authoritative, requestedEffort, requestedFastMode } = args;
  if (!authoritative) return true;
  const effortConsistent =
    authoritative.effort === undefined ||
    !requestedEffort ||
    authoritative.effort === requestedEffort;
  const fastConsistent =
    authoritative.fastMode === undefined || authoritative.fastMode === requestedFastMode;
  return effortConsistent && fastConsistent;
}

export function resolveAgentSwitchAckAction(args: {
  deferred: boolean;
  switched: boolean;
  sameEngineRevision?: number;
  sameEngineSuperseded?: boolean;
  /**
   * **deferred 分支专用**:ack 到达时 store 里的意图值,是不是逐字就是本次登记的那一份
   * (目标引擎 + 模型 + 来源)。
   *
   * 为什么需要它(Chris 2026-08-19 实测:「会话内换引擎整条链都不生效」的主根因):
   * main 在登记意图时**先同步广播 `sessions:patched`(带 agentSwitchIntent)、后返回 invoke
   * reply**。renderer 的 push 处理因此必然先于 ack 到达 —— 本地此刻还是 null,镜像一写就把
   * 修订号 +1。等 ack 回来,修订号守卫看到「变了」,把这次登记判成被外部超车而丢弃:乐观
   * 呈现、草稿同步、收藏锚点全都不落,而 main 的 pendingSwitches 里意图**还在** —— 下一条
   * 消息照样切引擎,用户看到的是「点了没反应,然后莫名其妙换了引擎」。
   *
   * 值相等就足以放行,因为它回答的正是修订号回答不了的那个问题:**此刻的权威值是不是我要
   * 的那一份**。相等 = 应用它不会覆盖任何更新的外部选择(它就是最新值);不等 = 真被外部
   * 超车,维持丢弃。ABA(外部 set → clear → set 回同值)最终值仍等于本次登记,应用无害;
   * 「用户又点了一次」由上面的写序号守卫独立覆盖,不靠这条。
   *
   * 刻意只比 target / model / providerId 三项:effort 与 fastMode 在 main 侧可能被目标引擎
   * 的档位集合归一化后才投影出来(projectPendingAgentSwitchIntent 只在有值时带上),比它们
   * 会把合法回声误判成不匹配,退回本次要修的那个 bug。providerId 还要再让一步:调用方传
   * `null` = 「我没指定来源,跟随默认路由」,main 可能解析出具体来源再投影回来,那一路只认
   * target + model(判据的构造见 ChatInput 的调用点)。
   *
   * effort / Fast 不进这条匹配判据 ≠ 不管:三元组放行只回答「该不该应用这份权威值」,
   * 「本端请求的完整配置有没有原样落地」由 isAgentSwitchEchoConfigConsistent 单独回答,
   * 切换事务的成功返回值挂在后者上(见其头注)。
   */
  registeredIntentMatchesCurrent?: boolean;
  freshness: AgentSwitchResponseFreshness;
}): AgentSwitchAckAction {
  const { freshness } = args;
  if (freshness.cancelled) return 'discard';
  if (freshness.writeSeqNow !== freshness.writeSeqAtStart) return 'discard';
  if (args.deferred) {
    if (isAgentSwitchResponseFresh(freshness)) return 'apply-intent';
    // 修订号变了,但当前权威值就是本次登记的那一份 → 变化来自本次登记自己的广播回声。
    return args.registeredIntentMatchesCurrent === true ? 'apply-intent' : 'discard';
  }
  if (!args.switched) {
    if (args.sameEngineSuperseded) return 'discard';
    if (args.sameEngineRevision !== undefined) return 'same-engine-reselect';
    return freshness.intentRevNow === freshness.intentRevAtStart
      ? 'same-engine-reselect'
      : 'discard';
  }
  return isAgentSwitchResponseFresh(freshness) ? 'apply-switched' : 'discard';
}
