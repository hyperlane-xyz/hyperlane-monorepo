import { deployBridges } from '../../src/bridge';
import { chains } from '../../config/environments/dev/chains';
import { addDeployerGCPKey } from '../../src/agents/gcp';
import { BridgeDeploy } from '../../src/bridge/BridgeDeploy';

const environment = 'dev';

async function main() {
  const _chains = await Promise.all(
    chains.map((c) => addDeployerGCPKey(environment, c)),
  );
  const deploys = _chains.map((c) => new BridgeDeploy(c, environment));
  await deployBridges(deploys);
}

main().then(console.log).catch(console.error);
