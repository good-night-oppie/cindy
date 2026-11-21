// Ported from makecindy/cindy#5611 (Ken / kenlinjie), source ref 87cbe126f42dcc3dd436297f3abb5c55ddf36620.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnAcpTransport } from './transport.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
function fixture(extra: Partial<Parameters<typeof spawnAcpTransport>[0]> = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 99999999, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn(),
  });
  const spawnChild = vi.fn(() => child);
  const exit = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  vi.spyOn(process, 'kill').mockImplementation(() => { exit(); return true; });
  const transport = spawnAcpTransport({ binaryPath: '/fake/cursor/agent', cwd: '/fake/project', spawnChild: spawnChild as unknown as typeof spawn, platformOverride: 'linux', ...extra });
  return { child, transport, spawnChild, exit };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('ACP stdio transport', () => {
  it('uses the exact absolute binary and ACP argument with no shell or permission bypass', async () => {
    const f = fixture();
    expect(f.spawnChild).toHaveBeenCalledWith('/fake/cursor/agent', ['acp'], expect.objectContaining({ cwd: '/fake/project', shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
    await f.transport.close();
    expect(() => spawnAcpTransport({ binaryPath: 'agent', cwd: '/project' })).toThrow('absolute');
  });
  it('frames split UTF-8 and multiple lines without corrupting characters', async () => {
    const f = fixture(); const lines: string[] = [];
    const bytes = Buffer.from('{"text":"你好"}\n{"id":0}\r\n');
    f.child.stdout.write(bytes.subarray(0, 10));
    f.transport.onLine(line => lines.push(line));
    f.child.stdout.write(bytes.subarray(10, 12)); f.child.stdout.write(bytes.subarray(12));
    expect(lines).toEqual(['{"text":"你好"}', '{"id":0}']); await f.transport.close();
  });
  it('bounds incomplete and initial queued frames and drains stderr without exposing it', async () => {
    const f = fixture({ maxFrameBytes: 8 }); const closed = vi.fn(); f.transport.onClose(closed);
    f.child.stderr.write('secret credential'); f.child.stdout.write('123456789');
    expect(closed).toHaveBeenCalledWith({ reason: 'ACP frame exceeds limit' });
    await f.transport.close();
    const g = fixture({ maxFrameBytes: 8 }); g.child.stdout.write('12345\n67890\n');
    const late = vi.fn(); g.transport.onClose(late);
    expect(late).toHaveBeenCalledWith({ reason: 'ACP initial frames exceed limit' }); await g.transport.close();
  });
  it('writes exactly one newline and rejects multiline or oversized output', async () => {
    const f = fixture({ maxFrameBytes: 8 }); let data = ''; f.child.stdin.on('data', chunk => { data += chunk.toString(); });
    await f.transport.writeLine('{"id":0}'); expect(data).toBe('{"id":0}\n');
    await expect(f.transport.writeLine('bad\nline')).rejects.toThrow('frame'); await f.transport.close();
    await expect(f.transport.writeLine('{}')).rejects.toThrow('closed');
  });
  it('escalates shutdown and requires observed exit, supports retry after failure', async () => {
    vi.useFakeTimers(); const f = fixture({ shutdownGraceMs: 10, killTimeoutMs: 20 });
    vi.mocked(process.kill).mockImplementation(() => true);
    const close = f.transport.close(); const assertion = expect(close).rejects.toThrow('could not be confirmed');
    expect(f.transport.close()).toBe(close);
    await vi.advanceTimersByTimeAsync(30); await assertion;
    expect(process.kill).toHaveBeenCalledWith(-f.child.pid, 'SIGTERM');
    expect(process.kill).toHaveBeenCalledWith(-f.child.pid, 'SIGKILL');
    expect(f.transport.getPid?.()).toBe(f.child.pid);
    f.exit(); await f.transport.close(); expect(f.transport.getPid?.()).toBeNull();
  });
  it('launches the Windows ACP binary directly and lets it exit on EOF', async () => {
    const f = fixture({ platformOverride: 'win32' });
    expect(f.spawnChild).toHaveBeenCalledWith('/fake/cursor/agent', ['acp'], expect.objectContaining({
      shell: false, detached: false, windowsHide: true,
    }));
    const closed = f.transport.close();
    expect(f.child.stdin.writableEnded).toBe(true);
    expect(f.child.kill).not.toHaveBeenCalled();
    f.exit();
    await closed;
    expect(f.child.kill).not.toHaveBeenCalled();
  });
  it('escalates only the direct Windows process and releases it after observed exit', async () => {
    vi.useFakeTimers();
    const f = fixture({ platformOverride: 'win32', shutdownGraceMs: 10, killTimeoutMs: 20 });
    const closed = f.transport.close();
    const failed = expect(closed).rejects.toThrow(/exit|SIGKILL/i);
    expect(f.child.stdin.writableEnded).toBe(true);
    expect(f.child.kill).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await failed;
    expect(f.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(process.kill).not.toHaveBeenCalled();
    expect(f.transport.getPid?.()).toBe(f.child.pid);
    f.exit();
    await f.transport.close();
    expect(f.transport.getPid?.()).toBeNull();
  });
  it('proves failed spawn has no child and propagates stdout EOF', async () => {
    const f = fixture(); Object.assign(f.child, { pid: undefined }); f.child.emit('error', new Error('private path'));
    await f.transport.close(); expect(f.transport.getPid?.()).toBeNull();
    const g = fixture(); const close = vi.fn(); g.transport.onClose(close); g.child.stdout.emit('end');
    expect(close).toHaveBeenCalledWith({ reason: 'ACP output ended' }); await g.transport.close();
  });
});
