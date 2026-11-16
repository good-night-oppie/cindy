import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { decideCodingRequest, codingFixtureIntact, type CodingPolicyIo } from '../../../scripts/agy-coding-policy.js';

// #25: the coding fixture previously denied every native request. This unit tier
// exercises its actual resolver policy with canonical-path I/O injected in memory.
// Protect directory boundaries and immutable tests without spawning a shell/agent.
const root = '/synthetic/coding';
const io: CodingPolicyIo = { realpath: async p => path.resolve(p), singleFile: async () => true, fixtureIntact: async () => true, treeSafe: async () => true };
const request = (toolName: string, input: unknown) => ({ kind: 'permission', toolName, input });
describe('coding fixture permission decisions', () => {
  it.each([
    request('Bash', { CommandLine: `ls -R ${root}` }),
    request('Bash', { CommandLine: 'ls -R .' }),
    ...[
      'ls -lah --color=never ./', 'cat -n ./calculator.py ./test_calculator.py',
      'head -n 20 calculator.py', 'tail --lines=5 test_calculator.py',
      'wc -l -w calculator.py test_calculator.py', 'stat --format="%s %n" calculator.py',
      'find . -maxdepth 2 -type f -name "*.py" -print',
      'grep -n -E "def|return" calculator.py', 'rg --glob "*.py" -n add .',
      'python3 -m unittest', 'python3 -m unittest -v test_calculator',
      'python3 -m unittest discover -s . -p "test_*.py" -v',
    ].map(command => request('Bash', { CommandLine: command })),
    request('Read', { Path: `${root}/calculator.py` }),
    request('Write', { TargetFile: `${root}/calculator.py` }),
    request('Bash', { CommandLine: 'python3 -m unittest -v' }),
  ])('allows a specific fixture action: %j', async r => {
    expect((await decideCodingRequest(r, root, io)).behavior).toBe('allow');
  });
  it.each([
    request('Read', { Path: '/outside/private.txt' }),
    request('Read', { Path: `${root}/link/../calculator.py` }),
    request('Bash', { CommandLine: 'ls', Cwd: `${root}/link/..` }),
    request('Write', { Path: `${root}/../outside.py` }),
    request('Write', { Path: `${root}-other/calculator.py` }),
    request('Write', { Path: `${root}/test_calculator.py` }),
    request('Bash', { CommandLine: 'python3 -m unittest -v; cat /outside/private.txt' }),
    request('Bash', { CommandLine: 'ls -R /outside' }),
    request('Bash', { CommandLine: 'ls -R ..' }),
    ...[
      'find . -exec sh -c id {} +', 'find . -delete', 'find . -fprint calculator.py',
      'rg --pre sh add .', 'wc --files0-from=calculator.py',
      'cat calculator.py | sh', 'cat calculator.py >> test_calculator.py', 'ls ~', 'cat ~/calculator.py', 'cat /outside/private.txt', 'ls --color /outside', 'grep --color add /outside/private.txt', 'ls . > calculator.py', 'curl https://example.test',
      'python3 -c "print(1)"', 'python3 -m unittest discover -s /outside',
      'grep -f /outside/patterns calculator.py', 'cat $(pwd)/calculator.py',
    ].map(command => request('Bash', { CommandLine: command })),
    request('Bash', { CommandLine: 'ls -R .; cat /outside/private.txt' }),
    request('Bash', { CommandLine: 'python3 -m unittest -v', Cwd: '/outside' }),
    request('Read', { Path: `${root}/calculator.py`, path: '/outside/private.txt' }),
    request('Unknown', { Path: `${root}/calculator.py` }),
  ])('denies an out-of-scope or ambiguous action: %j', async r => {
    expect((await decideCodingRequest(r, root, io)).behavior).toBe('deny');
  });
  it('rejects recursive reads when the fixture contains a link escape', async () => {
    expect((await decideCodingRequest(request('Bash', { CommandLine: 'ls -R .' }), root,
      { ...io, treeSafe: async () => false })).behavior).toBe('deny');
  });
  it('rejects a canonical path escaping through a symlink', async () => {
    const escaped = { ...io, realpath: async (p: string) => p === root ? root : '/outside/target' };
    expect((await decideCodingRequest(request('Write', { Path: `${root}/calculator.py` }), root, escaped)).behavior).toBe('deny');
  });
  it('rejects non-single-link files and changed test fixtures', async () => {
    expect((await decideCodingRequest(request('Write', { Path: `${root}/calculator.py` }), root,
      { ...io, singleFile: async () => false })).behavior).toBe('deny');
    expect((await decideCodingRequest(request('Bash', { CommandLine: 'python3 -m unittest -v' }), root,
      { ...io, fixtureIntact: async () => false })).behavior).toBe('deny');
  });
});

describe('coding unittest cache compatibility', () => {
  it('permits baseline tests then fixed-code retests with normal cache artifacts', async () => {
    let cached = false;
    let source = 'def add(a, b):\n    return a - b\n';
    const expected = 'synthetic immutable tests';
    const fs = {
      names: async (directory: string) => directory === root
        ? ['calculator.py', 'test_calculator.py', ...(cached ? ['__pycache__'] : [])]
        : ['calculator.cpython-313.pyc', 'test_calculator.cpython-313.pyc'],
      text: async (file: string) => file.endsWith('/calculator.py') ? source : expected,
    };
    const policyIo = { ...io, fixtureIntact: () => codingFixtureIntact(root, expected, fs) };
    const r = request('Bash', { CommandLine: 'python3 -m unittest discover -v' });
    expect((await decideCodingRequest(r, root, policyIo)).behavior).toBe('allow');
    cached = true; source = 'def add(a, b):\n    return a + b\n';
    expect((await decideCodingRequest(r, root, policyIo)).behavior).toBe('allow');
    expect(await codingFixtureIntact(root, 'changed expected tests', fs)).toBe(false);
    expect(await codingFixtureIntact(root, expected, { ...fs,
      names: async directory => directory === root ? ['calculator.py', 'test_calculator.py', '__pycache__'] : ['unexpected.py'],
    })).toBe(false);
  });
});
