import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { type IRegistry } from '@hyperlane-xyz/registry';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';

import { HttpServer } from '../HttpServer.js';

async function main() {
  const { registry } = await yargs(hideBin(process.argv))
    .option('registry', {
      alias: 'r',
      describe: 'The path to the registry',
      type: 'string',
      demandOption: true,
    })
    .parse();

  console.log(`Using registry path: ${registry}`);

  const getLocalRegistry = async (): Promise<IRegistry> => {
    return new FileSystemRegistry({
      uri: registry,
    });
  };

  const server = await HttpServer.create(getLocalRegistry);
  await server.start();
}

main().catch((error) => {
  console.error('Unhandled critical error in server execution script:', error);
  process.exit(1);
});
