import { getEnvironment, getCoreEnvironmentConfig } from './utils';
import { HelmCommand } from '../src/utils/helm';
import { runExternalSecretsHelmCommand } from '../src/infrastructure/external-secrets/external-secrets';

async function main() {
  const environment = await getEnvironment();
  const config = await getCoreEnvironmentConfig(environment);
  return runExternalSecretsHelmCommand(
    HelmCommand.Install,
    config.infra,
    environment,
  );
}

main().then(console.log).catch(console.error);
