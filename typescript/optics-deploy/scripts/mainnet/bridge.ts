import { deployBridges } from '../../src/bridge';
import { chains } from '../../config/environments/mainnet/chains';
import { BridgeDeploy } from '../../src/bridge/BridgeDeploy';

const environment = 'mainnet';

async function main() {
  const deploys = chains.map((c) => new BridgeDeploy(c, environment));
  await deployBridges(deploys);
}

main().then(console.log).catch(console.error);
