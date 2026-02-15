import { deleteAgentKeys } from '../../src/agents/key-utils.js';
import { getAgentConfigsBasedOnArgs } from '../agent-utils.js';

function stringifyValueForError(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unstringifiable>';
  }
}

async function main() {
  const { agentConfig } = await getAgentConfigsBasedOnArgs();
  return deleteAgentKeys(agentConfig);
}

main()
  .then(console.log)
  .catch((error) => console.error(stringifyValueForError(error)));
