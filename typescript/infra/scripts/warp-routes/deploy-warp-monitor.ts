import yargs from 'yargs';

import { HelmCommand } from '../../src/utils/helm.js';

import { runWarpRouteHelmCommand } from './helm.js';

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

  await runWarpRouteHelmCommand(
    HelmCommand.InstallOrUpgrade,
    'mainnet3',
    filePath,
  );
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
