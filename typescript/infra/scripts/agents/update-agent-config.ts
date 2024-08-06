import { writeAgentConfig } from '../../src/deployment/deploy.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const envConfig = getEnvironmentConfig(environment);

  let multiProvider = await envConfig.getMultiProvider(
    undefined,
    undefined,
    // Don't use secrets
    false,
  );

  await writeAgentConfig(multiProvider, environment);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Failed to update agent config', e);
    process.exit(1);
  });
