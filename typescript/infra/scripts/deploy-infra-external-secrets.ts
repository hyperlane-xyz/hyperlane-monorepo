import { getInfrastructureConfig, getEnvironment } from './utils';
import { HelmCommand } from '../src/utils/helm';
import { runExternalSecretsHelmCommand } from '../src/infrastructure/external-secrets/external-secrets';

async function main() {
  const environment = await getEnvironment();
  const infraConfig = await getInfrastructureConfig(environment);
  return runExternalSecretsHelmCommand(
    HelmCommand.InstallOrUpgrade,
    infraConfig,
    environment,
  );
}

main().then(console.log).catch(console.error);
