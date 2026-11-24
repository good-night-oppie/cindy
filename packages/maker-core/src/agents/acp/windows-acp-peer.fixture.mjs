import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';

const output = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const sessionId = 'win-direct-test';
const configOptions = [
  { id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: 'fixture-model',
    options: [{ value: 'fixture-model', name: 'Fixture' }] },
  { id: 'mode', category: 'mode', type: 'select', name: 'Mode', currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }] },
];
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  const reply = result => output({ id, result });
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
    case 'session/new':
    case 'session/resume':
    case 'session/set_config_option':
      return reply({ sessionId, configOptions });
    case 'session/prompt': {
      writeFileSync('peer-pid', String(process.pid));
      if (existsSync('hold-turn')) return;
      const text = params.prompt.findLast(block => block.type === 'text')?.text;
      output({ method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'received: ' + text },
      } } });
      return reply({ stopReason: 'end_turn' });
    }
  }
});
