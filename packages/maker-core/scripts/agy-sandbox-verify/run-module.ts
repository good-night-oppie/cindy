// verify.sh `module` mode: launch a stand-in binary exactly the way AgyAgent launches agy,
// through prepareAgySandboxedLaunch (pasta + bubblewrap). Usage:
//   npx tsx run-module.ts <taskDir> <stateDir> <binary>
// AGY_SANDBOX_TEST_PASTA points at a pasta binary when it is not installed system-wide.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { prepareAgySandboxedLaunch, probeAgySystemSandbox } from '../../src/agents/agy/system-sandbox.ts';

const [task, state, bin] = process.argv.slice(2);
if (!task || !state || !bin) throw new Error('usage: run-module.ts <taskDir> <stateDir> <binary>');
const pastaPath = process.env.AGY_SANDBOX_TEST_PASTA;
const probe = probeAgySystemSandbox(pastaPath ? { pastaCandidates: [pastaPath] } : {});
const launch = await prepareAgySandboxedLaunch({ probe, binaryPath: bin, args: [], taskDir: task, homeDir: os.homedir(),
  writableDirs: [{ source: state, target: `${os.homedir()}/.gemini` }], env: process.env });
const result = spawnSync(launch.command, launch.args, { cwd: task, env: launch.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
