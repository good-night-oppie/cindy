/**
 * agentKindConversion —— DB/renderer 形态('cc' | 'codex' | 'pi' | 'agy')与 maker-core
 * 形态('claude-code' | 'codex' | 'pi' | 'agy')的唯一双向映射。
 *
 * 背景:sessions.agent_kind 历史上存 renderer 形态('cc' 起家,default 'cc'),
 * maker-core 用 'claude-code'。三值化前全仓散落 `x === 'cc' ? 'claude-code' :
 * 'codex'` 这类二元 ternary —— pi 进来后每一处都会把 pi 误判成另一家。
 * 一律改走本模块;新增 agent 只改这里。
 */

/** DB(sessions.agent_kind)与 renderer 侧的 agent 形态。 */
export type DbAgentKind = 'cc' | 'codex' | 'pi' | 'agy';
/** maker-core / IPC 契约侧的 agent 形态。 */
export type MakerAgentKindWire = 'claude-code' | 'codex' | 'pi' | 'agy';

export function dbToMakerAgentKind(db: Exclude<DbAgentKind, 'agy'>): Exclude<MakerAgentKindWire, 'agy'>;
export function dbToMakerAgentKind(db: string | null | undefined): MakerAgentKindWire;
export function dbToMakerAgentKind(db: string | null | undefined): MakerAgentKindWire {
  if (db === 'codex') return 'codex';
  if (db === 'pi') return 'pi';
  if (db === 'agy') return 'agy';
  return 'claude-code'; // 'cc' 与历史缺省
}

export function makerToDbAgentKind(maker: Exclude<MakerAgentKindWire, 'agy'>): Exclude<DbAgentKind, 'agy'>;
export function makerToDbAgentKind(maker: string | null | undefined): DbAgentKind;
export function makerToDbAgentKind(maker: string | null | undefined): DbAgentKind {
  if (maker === 'codex') return 'codex';
  if (maker === 'pi') return 'pi';
  if (maker === 'agy') return 'agy';
  return 'cc'; // 'claude-code' 与历史缺省
}

/** 宽输入归一成 DbAgentKind;非法值回落 'cc'(与 sessions 表 default 同语义)。 */
export function normalizeDbAgentKind(value: Exclude<DbAgentKind, 'agy'> | 'orca'): Exclude<DbAgentKind, 'agy'>;
export function normalizeDbAgentKind(value: string | null | undefined): DbAgentKind;
export function normalizeDbAgentKind(value: string | null | undefined): DbAgentKind {
  return value === 'codex' || value === 'pi' || value === 'agy' ? value : 'cc';
}

/**
 * 「可启动/可切换」的引擎子集。agy 只作为历史任务身份保留,不进入新建、切换、
 * 预测等启动路径;这些路径先用下面的守卫收窄,遇到 agy 显式拒绝,不回落成 Claude。
 */
export type LaunchableDbAgentKind = Exclude<DbAgentKind, 'agy'>;
export type LaunchableMakerAgentKind = Exclude<MakerAgentKindWire, 'agy'>;

export function isLaunchableDbAgentKind(value: unknown): value is LaunchableDbAgentKind {
  return value === 'cc' || value === 'codex' || value === 'pi';
}

export function isLaunchableMakerAgentKind(value: unknown): value is LaunchableMakerAgentKind {
  return value === 'claude-code' || value === 'codex' || value === 'pi';
}

/**
 * An engine an existing task can be switched to from its model picker. Antigravity runs only on
 * the computer that hosts the task, so it is a target only when the task runs on this computer.
 */
/** Permission modes a task keeps when it switches into Antigravity from another engine. */
export const AGY_SWITCH_KEPT_PERMISSION_MODES = ['ask', 'default', 'auto'] as const;
/** Where Full access lands on that switch: Cindy reviews Antigravity's approval requests. */
export const AGY_SWITCH_FROM_FULL_ACCESS_PERMISSION_MODE = 'auto';
/** Where a mode Antigravity does not have (accept edits, plan, …) lands: the user decides each request. */
export const AGY_SWITCH_FROM_UNSUPPORTED_PERMISSION_MODE = 'ask';

/** Which of the two changes a switch into Antigravity makes to the task's mode; `null` keeps it. */
export function agySwitchPermissionChange(mode: string | null | undefined): 'fromFullAccess' | 'fromUnsupported' | null {
  if (mode === 'bypassPermissions') return 'fromFullAccess';
  return (AGY_SWITCH_KEPT_PERMISSION_MODES as readonly string[]).includes(mode ?? '') ? null : 'fromUnsupported';
}

/**
 * The permission mode a task has right after switching into Antigravity from another engine
 * (cindy#19, QQ 2026-11-22). Antigravity's Full access removes file and network isolation, so it
 * is never a starting value (cindy#1, PG 2026-11-19); the user can still choose it in the task
 * after the switch. The row commit applies the same rule in SQL (localDb/agentSwitchRows.ts) and
 * the switch dialog announces it; keep the three in step.
 */
export function permissionModeAfterSwitchToAgy(mode: string | null | undefined): string {
  const change = agySwitchPermissionChange(mode);
  if (change === 'fromFullAccess') return AGY_SWITCH_FROM_FULL_ACCESS_PERMISSION_MODE;
  return change === 'fromUnsupported' ? AGY_SWITCH_FROM_UNSUPPORTED_PERMISSION_MODE : mode!;
}

export function isSessionSwitchTargetAgentKind(
  value: unknown,
  sessionRunsOnThisComputer: boolean,
): value is MakerAgentKindWire {
  return isLaunchableMakerAgentKind(value) || (value === 'agy' && sessionRunsOnThisComputer);
}
