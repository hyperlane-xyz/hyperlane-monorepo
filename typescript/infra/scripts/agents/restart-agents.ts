import { AgentCli } from './utils.js';

async function main() {
  await new AgentCli().restartAgents();
}

main()
  .then(console.log)
  .catch((err) => {
    console.error('Error restarting agents:', err);
    process.exit(1);
  });
