import yargs from 'yargs';

import { HelmCommand } from '../../src/utils/helm.js';
import { WarpRouteMonitorHelmManager } from '../../src/warp/helm.js';
import { assertCorrectKubeContext } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { filePath } = await yargs(process.argv.slice(2))
    .alias('f', 'filePath')
    .describe(
      'filePath',
      'indicate the filepath to the warp route yaml file relative to the monorepo root',
    )
    .demandOption('filePath')
    .string('filePath')
    .parse();

  await assertCorrectKubeContext(getEnvironmentConfig('mainnet3'));

  const helmManager = new WarpRouteMonitorHelmManager(filePath, 'mainnet3');
  await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
