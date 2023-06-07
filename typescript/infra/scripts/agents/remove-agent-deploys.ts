import { HelmCommand } from '../../src/utils/helm';

import { AgentCli } from './utils';

async function main() {
  await new AgentCli().runHelmCommand(HelmCommand.Remove);
}

main().then(console.log).catch(console.error);
