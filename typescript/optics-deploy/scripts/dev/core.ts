import { deployNChains } from '../../src/core';
import { addDeployerGCPKey, addAgentGCPAddresses } from '../../src/agents/gcp';
import { CoreDeploy } from '../../src/core/CoreDeploy';
import { core } from '../../config/environments/dev/core';
import { chains } from '../../config/environments/dev/chains';

const environment = 'dev';

async function main() {
  const coreDeploys = await Promise.all(
    chains.map(
      async (c) =>
        new CoreDeploy(
          await addDeployerGCPKey(environment, c),
          await addAgentGCPAddresses(environment, c, core),
        ),
    ),
  );
  await deployNChains(coreDeploys);
}

main().then(console.log).catch(console.error);
