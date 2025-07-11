import { hideBin } from 'yargs/helpers';
import yargs from 'yargs/yargs';

import { IRegistry } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { rootLogger } from '@hyperlane-xyz/utils';

import { HttpServer } from '../HttpServer.js';

async function main() {
  const { registry, port, refreshInterval, authToken } = await yargs(
    hideBin(process.argv),
  )
    .option('registry', {
      alias: 'r',
      describe:
        'The URI of the registry to serve. Can be a local path or a remote URL.',
      type: 'string',
      demandOption: true,
    })
    .option('port', {
      alias: 'p',
      describe: 'The port to run the server on',
      type: 'number',
    })
    .option('refreshInterval', {
      alias: 'i',
      describe: 'The interval in seconds to refresh the registry',
      type: 'number',
    })
    .option('authToken', {
      alias: 't',
      describe: 'An optional authentication token for the registry',
      type: 'string',
    })
    .help()
    .parse();

  rootLogger.info(`Starting server on port ${port} for registry ${registry}`);

  const getRegistryInstance = async (): Promise<IRegistry> => {
    return getRegistry({
      registryUris: [registry],
      enableProxy: true,
      logger: rootLogger,
      authToken,
    });
  };

  const server = await HttpServer.create(getRegistryInstance);
  await server.start(port?.toString(), refreshInterval?.toString());
}

main().catch((err) =>
  rootLogger.error('Error in main execution', {
    err,
  }),
);
