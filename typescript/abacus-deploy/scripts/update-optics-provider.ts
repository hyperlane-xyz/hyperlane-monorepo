import { getCoreDeploys, getBridgeDeploys, getEnvironment } from './utils';
import { updateProviderDomain } from '../src/provider';

async function main() {
  const environment = await getEnvironment();
  const coreDeploys = await getCoreDeploys(environment);
  const bridgeDeploys = await getBridgeDeploys(environment);
  updateProviderDomain(environment, coreDeploys, bridgeDeploys);
}

main().then(console.log).catch(console.error);
