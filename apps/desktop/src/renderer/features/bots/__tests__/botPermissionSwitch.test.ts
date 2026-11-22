import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual shared composer callback without mounting the editor/model tree.
const source = ts.createSourceFile('ChatInput.tsx', readFileSync(resolve(__dirname,
  '../../../components/new-chat/ChatInput.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = '';
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handlePermissionModeChange') {
    callback = (node.initializer as ts.CallExpression).arguments[0]!.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('Permission switch callback missing');
const compiled = ts.transpileModule(`const handle = ${callback};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

function fixture() {
  const runtime = vi.fn(async (): Promise<void> => undefined);
  const persist = vi.fn(async () => undefined);
  const changed = vi.fn();
  const confirm = vi.fn(async () => true);
  const error = vi.fn();
  // cindy#19: while a switch into Antigravity is pending, a change of mode that the switch would
  // rewrite is agreed to first. Nothing is pending in these cases unless a test says so.
  const agreesWhileSwitchPending = vi.fn(async (_sessionId: string, _mode: string) => true);
  const env = {
    sessionId: 'bot-canonical', settingsLocked: false,
    activePermissionModeRef: { current: 'bypassPermissions' },
    requiresFullAccessConfirmation: (_previous: string, next: string) => next === 'bypassPermissions',
    confirmDialog: confirm, t: (key: string) => key,
    confirmPermissionChangeDuringAgySwitchRef: { current: agreesWhileSwitchPending },
    React: { createElement: () => null }, FullAccessConfirmContent: () => null, TriangleAlert: () => null,
    getSessionDeviceId: () => null,
    window: { electronAPI: { maker: { setPermissionMode: runtime } } },
    sessionService: { update: persist }, onPermissionModeDidChange: changed,
    log: { warn: vi.fn() }, toast: { error },
  };
  const change = new Function(...Object.keys(env), `${compiled}; return handle;`)(...Object.values(env)) as
    (mode: string, options?: { confirmFullAccess?: boolean }) => Promise<void>;
  return { runtime, persist, changed, confirm, error, change, agreesWhileSwitchPending };
}

describe('companion canonical task uses the standard live permission switch', () => {
  it('waits for the Host commit before reporting success without a second DB write', async () => {
    const f = fixture();
    let release!: () => void;
    f.runtime.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = f.change('ask');
    // The question about a pending switch is answered first, a step before the Host is told.
    await vi.waitFor(() => expect(f.runtime).toHaveBeenCalledWith('bot-canonical', 'ask'));
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    release();
    await pending;
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.changed).toHaveBeenCalledWith('ask');
  });

  // This file ran the callback from source without the reference above and has failed since
  // b679f8e5 (found on 2026-11-22; it was outside the suites run for cindy#19 until then).
  it('changes nothing when the user declines what a pending switch into Antigravity would do to the new mode', async () => {
    const f = fixture();
    f.agreesWhileSwitchPending.mockResolvedValueOnce(false);
    await f.change('ask');
    expect(f.agreesWhileSwitchPending).toHaveBeenCalledExactlyOnceWith('bot-canonical', 'ask');
    expect(f.runtime).not.toHaveBeenCalled();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
  });

  it('does not persist or claim a downgrade when the running task rejects it', async () => {
    const f = fixture();
    f.runtime.mockRejectedValueOnce(new Error('runtime failed'));
    await f.change('ask');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.error).toHaveBeenCalled();
  });

  it('does not send a stale rollback after the Host rejects persistence', async () => {
    const f = fixture();
    f.runtime.mockRejectedValueOnce(new Error('database failed'));
    await f.change('ask');
    expect(f.runtime.mock.calls).toEqual([
      ['bot-canonical', 'ask'],
    ]);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it.each(['ask', 'auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan'])(
    'reports %s only after the actual shared callback completes', async (mode) => {
      const f = fixture();
      await f.change(mode);
      expect(f.runtime).toHaveBeenCalledExactlyOnceWith('bot-canonical', mode);
      expect(f.persist).not.toHaveBeenCalled();
      expect(f.changed).toHaveBeenCalledWith(mode);
    },
  );

  it('selecting full access directly does not ask again', async () => {
    const f = fixture();
    await f.change('bypassPermissions');
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.runtime).toHaveBeenCalledWith('bot-canonical', 'bypassPermissions');
    expect(f.changed).toHaveBeenCalledWith('bypassPermissions');
  });

  it('requires explicit confirmation before the keyboard shortcut enables full access', async () => {
    const f = fixture();
    f.confirm.mockResolvedValueOnce(false);
    await f.change('bypassPermissions', { confirmFullAccess: true });
    expect(f.runtime).not.toHaveBeenCalled();
    await f.change('bypassPermissions', { confirmFullAccess: true });
    expect(f.runtime).toHaveBeenCalledWith('bot-canonical', 'bypassPermissions');
    expect(f.changed).toHaveBeenCalledWith('bypassPermissions');
  });
});
