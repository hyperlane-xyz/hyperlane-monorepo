import { HelmCommand } from '../../src/utils/helm.js';

import { AgentCli } from './utils.js';

async function main() {
  await new AgentCli().runHelmCommand(HelmCommand.UpgradeDiff);
}

main().then(console.log).catch(console.error);
