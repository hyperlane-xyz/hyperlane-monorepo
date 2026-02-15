import { createAgentKeysIfNotExistsWithPrompt } from '../../src/agents/key-utils.js';
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

  const created = await createAgentKeysIfNotExistsWithPrompt(agentConfig);

  if (created) {
    return 'Keys created successfully!';
  } else {
    return 'No new keys are created!';
  }
}

main()
  .then(console.log)
  .catch((error) => console.error(stringifyValueForError(error)));
