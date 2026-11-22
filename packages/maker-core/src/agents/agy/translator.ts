/**
 * ACP session/update → Cindy AgentEvent translation for agy.
 *
 * Structure ported from the Cursor ACP translator in makecindy/cindy#5611 (Ken / kenlinjie);
 * adapted to agy 1.5 frames: tool calls carry `name` + `rawInput` with PascalCase keys,
 * usage_update reports context occupancy, and per-turn billable usage only arrives on
 * the session/prompt result.
 */
import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import { record, type AcpRecord } from './models.js';
import {
  AGY_SANDBOX_USER_COPY_DRAFT, agySandboxDenialModelNote, detectAgySandboxDenial,
  type AgySandboxDenial, type AgySandboxDenialKind,
} from './system-sandbox.js';
import { AGY_HOST_PATH_USER_COPY, agyCopyLocale, agyWriteOutsideTask } from './host-path-guard.js';

/** File access mode chosen for this launch. */
interface AgyFileContext {
  isolated: boolean;
  taskDir: string; homeDir: string; visibleDirs: readonly string[];
  /** UI locale for user notices (JJ wrote zh-CN and en). */
  locale?: () => string | null | undefined;
}

// Provisional Windows/macOS wording pending JJ approval (cindy#1).
const hostWriteCopy = {
  completed: { en: 'Antigravity reported writing outside the task folder on this computer.',
    'zh-CN': 'Antigravity 报告已写入这台电脑上任务文件夹以外的位置。' },
  failed: { en: 'Antigravity reported an error while writing outside the task folder on this computer. Check the tool result for details.',
    'zh-CN': 'Antigravity 在写入这台电脑上任务文件夹以外的位置时报告了错误。详情见工具结果。' },
  unknownTarget: { en: 'This command may write outside the task folder on this computer. Check the tool result for details.',
    'zh-CN': '这条命令可能写入这台电脑上任务文件夹以外的位置。详情见工具结果。' },
};

export class AgyTranslator {
  private tools = new Map<string, AcpRecord>();
  private completedTools = new Set<string>();
  readonly usage: UsageSnapshot = { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };

  private sandboxNotified = new Set<string>();

  constructor(private emit: (event: AgentEvent) => void, private files?: AgyFileContext) {}

  beginTurn(): void {
    this.tools.clear();
    this.completedTools.clear();
    this.sandboxNotified.clear();
    this.usage.tokenUsage = 0;
    this.usage.outputTokens = 0;
  }

  /** Billable per-turn usage from the session/prompt result. */
  finishTurn(rawUsage: unknown): void {
    const usage = record(rawUsage);
    const input = finite(usage.inputTokens) ? usage.inputTokens : 0;
    const output = finite(usage.outputTokens) ? usage.outputTokens : 0;
    const cacheRead = finite(usage.cachedReadTokens) ? usage.cachedReadTokens : 0;
    const cacheWrite = finite(usage.cachedWriteTokens) ? usage.cachedWriteTokens : 0;
    this.usage.tokenUsage = finite(usage.totalTokens) ? usage.totalTokens : input + output + cacheRead + cacheWrite;
    this.usage.outputTokens = output;
  }

  update(raw: unknown): void {
    const update = record(raw);
    const event = (type: AgentEvent['type'], data: unknown) => this.emit({ type, data, source: 'agy' });
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const content = record(update.content);
        if (content.type === 'text' && typeof content.text === 'string' && content.text) {
          event(update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking', { text: content.text, isFinal: false });
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (typeof update.toolCallId !== 'string' || !update.toolCallId) break;
        const id = update.toolCallId;
        const previous = this.tools.get(id);
        const tool = { ...previous, ...update };
        this.tools.set(id, tool);
        if (!previous) event('tool_use', { toolUseId: id, toolName: agyToolName(tool), input: agyToolInput(tool) });
        if ((tool.status === 'completed' || tool.status === 'failed') && !this.completedTools.has(id)) {
          this.completedTools.add(id);
          let fullText = toolText(tool);
          // A write-type call aimed outside the task folder: only the target path decides, not agy's
          // completed / failed (cindy#1 QQ 6924350879 item 4). A notice beside the reply, not a block.
          const writeOutside = this.writeOutside(tool);
          if (writeOutside && this.files && !this.files.isolated) {
            const copy = writeOutside.startsWith('shell: ') ? hostWriteCopy.unknownTarget
              : tool.status === 'completed' ? hostWriteCopy.completed : hostWriteCopy.failed;
            event('error', { message: copy[agyCopyLocale(this.files.locale?.())], isTerminal: false, reason: 'agy_host_write_notice' });
          } else if (writeOutside && !this.sandboxNotified.has(writeOutside)) {
            this.sandboxNotified.add(writeOutside);
            event('error', { message: AGY_HOST_PATH_USER_COPY.writeOutside[agyCopyLocale(this.files?.locale?.())],
              isTerminal: false, reason: 'agy_write_outside_task' });
          }
          const denial = tool.status === 'failed' ? this.sandboxDenial(tool, fullText) : null;
          if (denial) {
            // Blocked by the isolation, not a missing file: tell the model not to retry, tell the user once per path.
            fullText = `${fullText.trimEnd()}\n\n${agySandboxDenialModelNote(denial)}`;
            // The write notice above already told the user about this step.
            if (!writeOutside && !this.sandboxNotified.has(denial.path)) {
              this.sandboxNotified.add(denial.path);
              event('error', { message: agySandboxBlockedText(denial, this.files?.locale?.()), isTerminal: false, reason: 'agy_sandbox_blocked', denial });
            }
          }
          event('tool_result_full', { toolUseId: id, fullText, isError: tool.status === 'failed' });
          event('tool_result', { summary: tool.status === 'failed' ? 'failed' : 'done', toolUseIds: [id] });
        }
        break;
      }
      case 'plan': {
        if (!Array.isArray(update.entries)) break;
        event('tool_use', { toolUseId: 'agy-plan', toolName: 'update_plan', input: {
          plan: update.entries.map(record).map(entry => ({ step: String(entry.content ?? ''), status: entry.status })),
        } });
        event('tool_result_full', { toolUseId: 'agy-plan', fullText: '', isError: false });
        break;
      }
      case 'usage_update': {
        // ACP used/size describe context occupancy, never per-request billable usage.
        if (finite(update.used)) this.usage.contextTokens = update.used;
        if (finite(update.size)) this.usage.contextWindow = update.size;
        event('status', { ...this.usage, isRunning: true, status: 'Working' });
        break;
      }
    }
  }

  tool(id: unknown): AcpRecord { return typeof id === 'string' ? this.tools.get(id) ?? {} : {}; }

  private writeOutside(tool: AcpRecord): string | null {
    if (!this.files) return null;
    try { return agyWriteOutsideTask(tool, this.files.taskDir, this.files.homeDir, this.files.visibleDirs); } catch { return null; }
  }

  private sandboxDenial(tool: AcpRecord, errorText: string): AgySandboxDenial | null {
    if (!this.files?.isolated) return null;
    const kind: AgySandboxDenialKind = tool.kind === 'read' || tool.kind === 'search' ? 'read'
      : tool.kind === 'edit' || tool.kind === 'delete' ? 'write' : 'unknown';
    return detectAgySandboxDenial({ paths: agyToolPaths(tool, this.files.homeDir), errorText,
      taskDir: this.files.taskDir, visibleDirs: this.files.visibleDirs, kind });
  }
}

/** Paths a tool call refers to: path-like input fields, ACP locations, and absolute paths in a command line. */
export function agyToolPaths(tool: AcpRecord, homeDir: string): string[] {
  const input = agyToolInput(tool);
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) out.push(value.startsWith('~/') ? homeDir + value.slice(1) : value);
  };
  for (const [key, value] of Object.entries(input)) if (/path|file|dir|cwd/i.test(key)) add(value);
  if (Array.isArray(tool.locations)) for (const location of tool.locations) add(record(location).path);
  if (typeof input.command === 'string') {
    for (const match of input.command.matchAll(/(?:^|[\s'"=])((?:~|\.\.)?\/[^\s'"`;|&<>()]+)/g)) add(match[1]);
  }
  return out;
}

/** Human-readable fallback for clients without structured file access cards. */
export function agySandboxBlockedText(denial: AgySandboxDenial, locale?: string | null): string {
  const copy = AGY_SANDBOX_USER_COPY_DRAFT.blocked;
  const lang = agyCopyLocale(locale);
  return copy[lang].replace('{action}', copy.action[denial.kind][lang]).replace('{path}', () => denial.path);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const KIND_NAMES: Record<string, string> = { read: 'Read', edit: 'Edit', delete: 'Delete', execute: 'Bash', search: 'Search', fetch: 'WebFetch' };

export function agyToolName(tool: AcpRecord): string {
  return (typeof tool.kind === 'string' ? KIND_NAMES[tool.kind] : undefined)
    ?? (typeof tool.name === 'string' && tool.name ? tool.name : undefined)
    ?? (typeof tool.title === 'string' ? tool.title : 'agy tool');
}

export function agyToolInput(tool: AcpRecord): AcpRecord {
  const raw = record(tool.rawInput);
  const input = Object.keys(raw).length ? raw : record(tool.args);
  if (Object.keys(input).length) {
    // Normalize agy's PascalCase fields to the names Cindy's tool cards already render.
    const command = input.CommandLine ?? input.command;
    const filePath = input.Path ?? input.AbsolutePath ?? input.TargetFile ?? input.file_path;
    return {
      ...input,
      ...(typeof command === 'string' ? { command } : {}),
      ...(typeof filePath === 'string' ? { file_path: filePath } : {}),
      ...(typeof input.Cwd === 'string' ? { cwd: input.Cwd } : {}),
      ...(typeof tool.title === 'string' && !('description' in input) ? { description: tool.title } : {}),
    };
  }
  return {
    ...(typeof tool.title === 'string' ? { description: tool.title } : {}),
    ...(Array.isArray(tool.locations) ? { locations: tool.locations } : {}),
  };
}

function toolText(tool: AcpRecord): string {
  const sections: string[] = [];
  if (Array.isArray(tool.content)) for (const raw of tool.content) {
    const item = record(raw);
    if (item.type === 'content') {
      const content = record(item.content);
      if (typeof content.text === 'string' && content.text) sections.push(content.text);
    } else if (item.type === 'diff') {
      sections.push(JSON.stringify({ path: item.path, oldText: item.oldText, newText: item.newText }));
    }
  }
  if (!sections.length) {
    if (typeof tool.rawOutput === 'string') sections.push(tool.rawOutput);
    else {
      const output = record(tool.rawOutput);
      if (typeof output.output === 'string' && output.output) sections.push(output.output);
      else if (Object.keys(output).length) sections.push(JSON.stringify(output));
    }
  }
  return sections.join('\n');
}
