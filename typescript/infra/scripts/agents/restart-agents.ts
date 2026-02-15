import { AgentCli } from './utils.js';

function stringifyValueForError(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unstringifiable>';
  }
}

async function main() {
  await new AgentCli().restartAgents();
}

main()
  .then(console.log)
  .catch((err) => {
    console.error(`Error restarting agents: ${stringifyValueForError(err)}`);
    process.exit(1);
  });
