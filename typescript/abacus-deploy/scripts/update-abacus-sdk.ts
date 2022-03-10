import {
  getCoreDeploy,
  getBridgeDeploy,
  getGovernanceDeploy,
  getEnvironment,
} from './utils';
import { updateSdkDomain } from '../src/sdk';

async function main() {
  const environment = await getEnvironment();
  const coreDeploy = await getCoreDeploy(environment);
  const bridgeDeploy = await getBridgeDeploy(environment);
  const governanceDeploy = await getGovernanceDeploy(environment);
  updateSdkDomain(environment, coreDeploy, governanceDeploy, bridgeDeploy);
}

main().then(console.log).catch(console.error);
