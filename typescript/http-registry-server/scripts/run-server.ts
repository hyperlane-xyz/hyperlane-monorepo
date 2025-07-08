import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { type IRegistry } from '@hyperlane-xyz/registry';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';

import { HttpServer } from '../HttpServer.js';

const main = async () => {
  const { registry } = await yargs(hideBin(process.argv))
    .option('registry', {
      alias: 'r',
      type: 'string',
      description: 'The path to the registry',
      demandOption: true,
    })
    .parse();

  console.log(`Using registry path: ${registry}`);

  const getLocalRegistry = async (): Promise<IRegistry> => {
    return new FileSystemRegistry({
      uri: registry,
    });
  };

  const server = new HttpServer(getLocalRegistry);

  try {
    await server.start();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

main().catch((error) => {
  console.error('Unhandled critical error in server execution script:', error);
  process.exit(1);
});
