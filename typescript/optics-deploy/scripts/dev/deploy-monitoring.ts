import { HelmCommand } from '../../src/agents';
import { runPrometheusHelmCommand } from '../../src/infra/monitoring/prometheus';
import { infrastructure } from '../../config/environments/dev/infrastructure';

const environment = 'dev';

async function main() {
  return runPrometheusHelmCommand(HelmCommand.Install, infrastructure);
}

main().then(console.log).catch(console.error);
