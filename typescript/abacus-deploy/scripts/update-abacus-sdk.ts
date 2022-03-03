import { getCoreDeploys, getBridgeDeploys, getEnvironment } from './utils';
import { updateSdkDomain } from '../src/sdk';

async function main() {
  const environment = await getEnvironment();
  const coreDeploys = await getCoreDeploys(environment);
  const bridgeDeploys = await getBridgeDeploys(environment);
  updateSdkDomain(environment, coreDeploys, bridgeDeploys);
}

main().then(console.log).catch(console.error);
