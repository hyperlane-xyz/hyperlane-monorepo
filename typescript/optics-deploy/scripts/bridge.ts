import { getEnvironment, getBridgeDeploys } from './utils';
import { deployBridges } from '../src/bridge';

async function main() {
  const environment = await getEnvironment();
  const deploys = await getBridgeDeploys(environment);
  await deployBridges(deploys);
}

main().then(console.log).catch(console.error);
