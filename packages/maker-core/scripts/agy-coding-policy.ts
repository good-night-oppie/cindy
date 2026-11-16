import path from 'node:path';
export interface CodingPolicyIo {
  realpath(path: string): Promise<string>;
  singleFile(path: string): Promise<boolean>;
  fixtureIntact(): Promise<boolean>;
  treeSafe(): Promise<boolean>;
}
type Decision = { behavior: 'allow' | 'deny'; reason: string };
const deny = (reason: string): Decision => ({ behavior: 'deny', reason });
const allow = (reason: string): Decision => ({ behavior: 'allow', reason });
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Restricted synthetic-fixture resolver, not a general shell policy or sandbox. */
export async function decideCodingRequest(request: unknown, root: string, io: CodingPolicyIo): Promise<Decision> {
  try {
    const r = record(request); const input = record(r.input);
    if (r.kind !== 'permission' || typeof r.toolName !== 'string') return deny('unsupported-request');
    const canonicalRoot = await io.realpath(root);
    if (canonicalRoot !== root || !/^\/[A-Za-z0-9_./-]+$/.test(root)) return deny('unstable-root');
    for (const key of ['Cwd', 'cwd', 'workingDirectory']) {
      if (key in input && (input[key] !== root || await io.realpath(input[key] as string) !== root)) return deny('outside-cwd');
    }
    if (['env', 'Env', 'Environment', 'RunAsync'].some(key => key in input)) return deny('execution-overrides');
    const safeFile = async (target: string) => {
      const resolved = path.resolve(root, target);
      if (![path.join(root, 'calculator.py'), path.join(root, 'test_calculator.py')].includes(resolved)) return false;
      return await io.realpath(resolved) === resolved && await io.singleFile(resolved);
    };
    if (['Bash', 'run_command', 'RunCommand'].includes(r.toolName)) {
      const commands = ['CommandLine', 'command', 'cmd'].filter(key => key in input).map(key => input[key]);
      if (!commands.length || commands.some(value => typeof value !== 'string' || value !== commands[0])) return deny('ambiguous-command');
      const words = shellWords(commands[0] as string);
      if (!words?.length) return deny('shell-syntax');
      const [program, ...args] = words;
      const targets = commandPaths(program, args);
      if (!targets) return deny('command-not-allowed');
      for (const target of targets) {
        if (target.split(/[\\/]/).includes('..')) return deny('outside-target');
        const resolved = path.resolve(root, target);
        const canonical = await io.realpath(resolved);
        if (canonical !== root && !canonical.startsWith(root + path.sep)) return deny('outside-target');
      }
      // Recursive readers must not traverse a link hidden under an allowed root.
      if (!await io.treeSafe()) return deny('unsafe-tree');
      if (program === 'python3' || program === 'python') {
        if (!await safeFile('calculator.py') || !await safeFile('test_calculator.py') || !await io.fixtureIntact()) return deny('changed-test-fixture');
        return allow('fixture-tests');
      }
      return allow('fixture-read-command');
    }
    const reading = ['Read', 'ReadFile', 'read_file', 'view_file'].includes(r.toolName);
    const writing = ['Write', 'Edit', 'WriteFile', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(r.toolName);
    if (!reading && !writing) return deny('unsupported-tool');
    const targets = ['Path', 'AbsolutePath', 'TargetFile', 'path', 'filePath', 'file_path', 'target_file', 'targetPath', 'absolutePath']
      .filter(key => key in input).map(key => input[key]);
    if (!targets.length || targets.some(value => typeof value !== 'string' || value.split(/[\\/]/).includes('..'))) return deny('missing-target');
    const resolved = targets.map(value => path.resolve(root, value as string));
    if (resolved.some(value => value !== resolved[0])) return deny('outside-or-ambiguous-target');
    const canonical = await io.realpath(resolved[0]);
    if (!canonical.startsWith(root + path.sep) || !await io.singleFile(canonical) || !await io.treeSafe()) return deny('outside-or-ambiguous-target');
    if (writing && canonical !== resolved[0]) return deny('link-write');
    if (writing && resolved[0] !== path.join(root, 'calculator.py')) return deny('immutable-tests');
    return allow(writing ? 'fixture-write' : 'fixture-read');
  } catch { return deny('path-check-failed'); }
}

/** Tokenize only a simple command: no expansion, redirection, pipelines or subshells.
 * Quoted patterns stay literal; they are not evaluated by this policy.
 */
function shellWords(command: string): string[] | null {
  if (!command || command.length > 8192 || /[\r\n\0\\]/.test(command)) return null;
  const words: string[] = []; let word = ''; let quote = ''; let active = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = '';
      else { if (quote === '"' && (char === '$' || char === '`')) return null; word += char; }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; active = true; continue; }
    if (/\s/.test(char)) { if (active) { words.push(word); word = ''; active = false; } continue; }
    if (';&|<>$`(){}*?[~'.includes(char)) return null;
    word += char; active = true;
  }
  if (quote) return null;
  if (active) words.push(word);
  return words;
}
type ArgKind = 'path' | 'value';
interface ReadOptions { shortValues?: Record<string, ArgKind>; longValues?: Record<string, ArgKind>; flags: string[]; shortFlags: string; optionalValues?: string[] }
const READ_OPTIONS: Record<string, ReadOptions> = {
  pwd: { flags: ['logical', 'physical'], shortFlags: 'LP' },
  ls: { optionalValues: ['color', 'hyperlink'], flags: ['all', 'almost-all', 'recursive', 'human-readable', 'dereference', 'directory', 'classify', 'numeric-uid-gid', 'reverse', 'size', 'inode'], shortFlags: 'aAbBcCdDfFgGhHiIkLlmnNopqQrRsStTuUvwxX1',
    shortValues: { I: 'value', w: 'value', T: 'value' }, longValues: Object.fromEntries(['color','format','sort','time','time-style','indicator-style','quoting-style','hide','ignore','block-size','width','tabsize','hyperlink'].map(k => [k,'value'])) },
  cat: { flags: ['number','number-nonblank','show-all','show-ends','show-tabs','show-nonprinting','squeeze-blank'], shortFlags: 'AbEenstTuv' },
  head: { flags: ['quiet','silent','verbose','zero-terminated'], shortFlags: 'qvz', shortValues: { n:'value', c:'value' }, longValues: { lines:'value', bytes:'value' } },
  tail: { flags: ['quiet','silent','verbose','zero-terminated'], shortFlags: 'qvz', shortValues: { n:'value', c:'value' }, longValues: { lines:'value', bytes:'value' } },
  wc: { flags: ['bytes','chars','lines','words','max-line-length','total'], shortFlags: 'cmlwL', longValues: { total:'value' } },
  stat: { flags: ['dereference','file-system','terse'], shortFlags: 'Lft', shortValues: { c:'value' }, longValues: { format:'value', printf:'value' } },
  du: { flags: ['all','summarize','human-readable','bytes','total','apparent-size','dereference','one-file-system','null'], shortFlags: 'aBbcDhHklLmsSx0', shortValues: { d:'value', B:'value' }, longValues: { 'max-depth':'value','block-size':'value',exclude:'value','exclude-from':'path',threshold:'value' } },
};
function readPaths(args: string[], spec: ReadOptions): string[] | null {
  const paths: string[] = []; let positional = false;
  for (let i=0; i<args.length; i++) {
    const arg=args[i];
    if (arg === '--' && !positional) { positional=true; continue; }
    if (!positional && arg.startsWith('--')) {
      const split=arg.indexOf('='); const key=arg.slice(2,split<0?undefined:split);
      if (split < 0 && spec.optionalValues?.includes(key)) continue;
      const kind=spec.longValues?.[key];
      if (kind) { const value=split<0?args[++i]:arg.slice(split+1); if (!value) return null; if(kind==='path') paths.push(value); }
      else if (split>=0 || ![...spec.flags,'help','version'].includes(key)) return null;
    } else if (!positional && arg.startsWith('-') && arg!=='-') {
      for(let j=1;j<arg.length;j++) {
        const kind=spec.shortValues?.[arg[j]];
        if(kind) { const value=arg.slice(j+1)||args[++i]; if(!value)return null; if(kind==='path')paths.push(value); break; }
        if(!spec.shortFlags.includes(arg[j]))return null;
      }
    } else { if(arg==='-')return null; paths.push(arg); }
  }
  return paths.length ? paths : ['.'];
}
/** Classify option values so patterns/counts are not confused with file paths. */
function commandPaths(program: string, args: string[]): string[] | null {
  if (READ_OPTIONS[program]) return readPaths(args, READ_OPTIONS[program]);
  if (program === 'python3' || program === 'python') {
    let i=0; if(args[i]==='-B')i++;
    if(args[i++]!=='-m'||args[i++]!=='unittest')return null;
    const paths=['.'];
    if(args[i]==='discover')i++;
    for(;i<args.length;i++) {
      const a=args[i];
      if(['-v','--verbose','-q','--quiet','-f','--failfast','-b','--buffer'].includes(a))continue;
      if(['-s','--start-directory','-t','--top-level-directory'].includes(a)) { if(!args[i+1])return null; paths.push(args[++i]); continue; }
      if(['-p','--pattern','-k'].includes(a)) { if(!args[++i] || args[i].includes('/'))return null; continue; }
      if(!/^test_calculator(?:\.py|(?:\.[A-Za-z_][A-Za-z_0-9]*)*)$/.test(a) && a!=='test_calculator')return null;
    }
    return paths;
  }
  if (program === 'find') {
    const paths: string[]=[];
    const valueFlags=new Set(['-name','-iname','-path','-ipath','-regex','-iregex','-type','-maxdepth','-mindepth','-size','-mtime','-mmin','-perm','-printf']);
    const flags=new Set(['-H','-L','-P','-print','-print0','-ls','-empty','-readable','-writable','-executable','-quit','-a','-and','-o','-or','-not','!']);
    for(let i=0;i<args.length;i++) {
      const a=args[i];
      if(valueFlags.has(a)) { if(args[++i]===undefined)return null; continue; }
      if(a==='-newer'||a==='-samefile') { if(!args[i+1])return null; paths.push(args[++i]); continue; }
      if(flags.has(a))continue;
      if(a.startsWith('-'))return null;
      paths.push(a);
    }
    return paths.length?paths:['.'];
  }
  if (program === 'grep' || program === 'rg') {
    let hasPattern=false; let filesMode=false; const paths: string[]=[]; let positional=false;
    const values=new Set(['--glob','--iglob','--type','--type-not','--color','--colors','--max-count','--max-depth','--context','--before-context','--after-context','--encoding','--include','--exclude','--exclude-dir']);
    for(let i=0;i<args.length;i++) {
      const a=args[i];
      if(a==='--'&&!positional) { positional=true; continue; }
      if(!positional&&['-e','--regexp'].includes(a)) { if(args[++i]===undefined)return null; hasPattern=true;continue; }
      if(!positional&&['-f','--file','--ignore-file','--exclude-from'].includes(a)) { if(!args[i+1])return null; paths.push(args[++i]); if(a==='-f'||a==='--file')hasPattern=true; continue; }
      if(!positional&&['--files','--type-list'].includes(a)) { filesMode=true;continue; }
      if(!positional&&a.startsWith('--')) {
        const key=a.split('=')[0];
        if(program === 'grep' && key === '--color' && !a.includes('=')) continue;
        if(values.has(key)) { if(!a.includes('=')&&args[++i]===undefined)return null; continue; }
        if(['--line-number','--ignore-case','--fixed-strings','--extended-regexp','--recursive','--hidden','--no-ignore','--count','--files-with-matches','--files-without-match','--word-regexp','--invert-match','--no-heading','--heading','--follow','--null','--help','--version'].includes(a))continue;
        return null;
      }
      if(!positional&&a.startsWith('-')) {
        if(/^-[nriIFEvwxlLcshHuUo0]+$/.test(a))continue;
        if(/^-[mABCg]$/.test(a)) { if(args[++i]===undefined)return null;continue; }
        if(/^-[mABC]\d+$/.test(a))continue;
        return null;
      }
      if(!hasPattern&&!filesMode)hasPattern=true;else paths.push(a);
    }
    if(!hasPattern&&!filesMode)return null;
    return paths.length?paths:['.'];
  }
  return null;
}

/** Fixed synthetic source/tests plus ordinary Python import caches; no new code files. */
export async function codingFixtureIntact(root: string, expectedTests: string, io: {
  names(directory: string): Promise<string[]>;
  text(file: string): Promise<string>;
}): Promise<boolean> {
  const names = await io.names(root);
  if (names.some(name => !['calculator.py', 'test_calculator.py', '__pycache__'].includes(name))) return false;
  if (names.includes('__pycache__')) {
    const caches = await io.names(path.join(root, '__pycache__'));
    if (caches.some(name => !/^(?:calculator|test_calculator)\.cpython-\d+(?:\.opt-\d+)?\.pyc$/.test(name))) return false;
  }
  const source = await io.text(path.join(root, 'calculator.py'));
  return /^def add\(a, b\):\r?\n {4}return a [+-] b\r?\n?$/.test(source)
    && await io.text(path.join(root, 'test_calculator.py')) === expectedTests;
}
