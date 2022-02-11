import { HelmCommand } from '../../src/agents';
import { runPrometheusHelmCommand } from '../../src/infrastructure/monitoring/prometheus';
import { infrastructure } from '../../config/environments/testnet/infrastructure';

const environment = 'testnet';

async function main() {
  return runPrometheusHelmCommand(
    HelmCommand.Install,
    infrastructure,
    environment,
  );
}

main().then(console.log).catch(console.error);
