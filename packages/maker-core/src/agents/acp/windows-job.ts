import path from 'node:path';

// Keep the supervisor outside the job. Windows assigns membership atomically at
// CreateProcessW, before agy or any child can execute. The only job handle is
// non-inheritable. Loss of the supervisor therefore also closes the job.
const supervisor = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class CindyAcpJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Limits {
    public BasicLimits Basic;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Startup {
    public int Size;
    public IntPtr Reserved, Desktop, Title;
    public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
    public ushort Show, ReservedBytes;
    public IntPtr ReservedData, Input, Output, Error, Attributes;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref Limits limits, int size);
  [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int info, out Accounting counts, int size, IntPtr returned);
  [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr procAttributes, IntPtr threadAttributes,
    bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }

  static ProcessInfo Start(IntPtr job, IntPtr stdin, string app, string cmd, string cwd, string env) {
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    IntPtr slot = Marshal.AllocHGlobal(IntPtr.Size);
    IntPtr handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
    IntPtr environment = Marshal.StringToHGlobalUni(env);
    bool initialized = false;
    try {
      Check(InitializeProcThreadAttributeList(list, 2, 0, ref size));
      initialized = true;
      Marshal.WriteIntPtr(slot, job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES, EXTENDED_STARTUPINFO_PRESENT.
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x2000D), slot, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      Startup si = new Startup { Size=Marshal.SizeOf(typeof(Startup)), Flags=0x100,
        Input=stdin, Output=GetStdHandle(-11), Error=GetStdHandle(-12), Attributes=list };
      // Only the three ACP streams may be inherited, including on nested launches.
      Marshal.WriteIntPtr(handles, 0, si.Input);
      Marshal.WriteIntPtr(handles, IntPtr.Size, si.Output);
      Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, si.Error);
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles,
        new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      ProcessInfo proc;
      Check(CreateProcessW(app, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, true, 0x08080400,
        environment, cwd, ref si, out proc));
      return proc;
    } finally {
      if (initialized) DeleteProcThreadAttributeList(list);
      Marshal.FreeHGlobal(list);
      Marshal.FreeHGlobal(slot);
      Marshal.FreeHGlobal(handles);
      Marshal.FreeHGlobal(environment);
    }
  }

  public static void Run(string app, string cmd, string cwd, string env, int parentPid) {
    using (Process parent = Process.GetProcessById(parentPid))
    using (var parentExit = new ManualResetEvent(false))
    using (var inputEnded = new ManualResetEvent(false))
    using (var rootExit = new ManualResetEvent(false))
    using (var input = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable)) {
      parentExit.SafeWaitHandle = new SafeWaitHandle(parent.Handle, false);
      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      Check(job != IntPtr.Zero);
      try {
        Limits limits = new Limits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Limits))));
        ProcessInfo proc;
        try { proc = Start(job, input.ClientSafePipeHandle.DangerousGetHandle(), app, cmd, cwd, env); }
        catch (Win32Exception error) {
          // CreateProcessW failed atomically. No member was started.
          Console.Error.WriteLine(error.Message);
          return;
        }
        CloseHandle(proc.Thread);
        rootExit.SafeWaitHandle = new SafeWaitHandle(proc.Process, true);
        input.DisposeLocalCopyOfClientHandle();
        var pump = new Thread(delegate() {
          try { Console.OpenStandardInput().CopyTo(input); }
          catch (IOException) { }
          catch (ObjectDisposedException) { }
          finally { try { inputEnded.Set(); } catch (ObjectDisposedException) { } }
        });
        pump.IsBackground = true;
        pump.Start();
        WaitHandle.WaitAny(new WaitHandle[] { rootExit, inputEnded, parentExit });
        Check(TerminateJobObject(job, 1));
        Accounting counts;
        do {
          Check(QueryInformationJobObject(job, 1, out counts, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
          if (counts.Active != 0) Thread.Sleep(10);
        } while (counts.Active != 0);
      } finally { CloseHandle(job); }
    }
  }
}
`;

// Arguments are data passed directly to CreateProcessW, never PowerShell code.
function quoteWindowsArg(arg: string): string {
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
}

export function windowsAcpLaunch(binary: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const system = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  // PowerShell initializes variables of its own. Supply the prepared target environment
  // directly to CreateProcessW so ACP sees precisely the environment selected by the host.
  const entries = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
  entries.sort(([a], [b]) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);
  const environment = entries.map(([name, value]) => name + '=' + value).join('\0') + '\0\0';
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  $config = $env:CINDY_ACP_JOB_LAUNCH | ConvertFrom-Json
  Remove-Item Env:CINDY_ACP_JOB_LAUNCH
  Add-Type -TypeDefinition @'
${supervisor}
'@
  [CindyAcpJob]::Run($config.app, $config.command, $config.cwd, $config.environment, $config.parent)
  exit 0
} catch {
  [Console]::Error.WriteLine('Windows ACP job supervisor failed: ' + $_.Exception.GetBaseException().Message)
  exit 1
}`;
  return {
    binary: path.win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    cwd: system,
    env: {
      SystemRoot: process.env.SystemRoot, PATH: system, TEMP: process.env.TEMP, TMP: process.env.TMP,
      CINDY_ACP_JOB_LAUNCH: JSON.stringify({
        app: binary, command: [binary, ...args].map(quoteWindowsArg).join(' '), cwd, environment, parent: process.pid,
      }),
    },
  };
}
