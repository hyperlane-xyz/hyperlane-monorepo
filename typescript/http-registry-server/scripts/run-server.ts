import { type IRegistry } from '@hyperlane-xyz/registry';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';

import { HttpServer } from '../HttpServer.js';

const main = async () => {
  const registryPath = process.argv[2];

  if (!registryPath) {
    throw new Error('Registry path is required');
  }

  console.log(`Using registry path: ${registryPath}`);

  const getLocalRegistry = async (): Promise<IRegistry> => {
    return new FileSystemRegistry({
      uri: registryPath,
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
