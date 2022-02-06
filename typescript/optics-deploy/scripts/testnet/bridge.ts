import { deployBridges } from '../../src/bridge';
import { BridgeDeploy } from '../../src/bridge/BridgeDeploy';
import { chains } from '../../config/environments/testnet/chains';

const environment = 'testnet';

async function main() {
  const deploys = chains.map((c) => new BridgeDeploy(c, environment));
  await deployBridges(deploys);
}

main().then(console.log).catch(console.error);
