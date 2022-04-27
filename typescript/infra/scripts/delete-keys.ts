import { deleteAgentGCPKeys } from '../src/agents/gcp';
import { getCoreEnvironmentConfig, getEnvironment } from './utils';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);

  const domains = Object.keys(config.transactionConfigs);
  return deleteAgentGCPKeys(environment, domains);
}

main().then(console.log).catch(console.error);
