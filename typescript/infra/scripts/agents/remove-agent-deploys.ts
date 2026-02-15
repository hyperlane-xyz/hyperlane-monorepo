import { HelmCommand } from '../../src/utils/helm.js';

import { AgentCli } from './utils.js';

function stringifyValueForError(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unstringifiable>';
  }
}

async function main() {
  await new AgentCli().runHelmCommand(HelmCommand.Remove);
}

main()
  .then(console.log)
  .catch((error) => console.error(stringifyValueForError(error)));
