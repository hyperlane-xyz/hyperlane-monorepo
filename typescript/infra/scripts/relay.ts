import { HyperlaneRelayer, RelayerCacheSchema } from '@hyperlane-xyz/sdk';

import { readFile, writeFile } from 'fs/promises';

import { getArgs } from './agent-utils.js';
import { getHyperlaneCore } from './core-utils.js';

const CACHE_PATH = process.env.RELAYER_CACHE ?? './relayer-cache.json';

async function main() {
  const { environment } = await getArgs().argv;
  const { core } = await getHyperlaneCore(environment);

  // target subset of chains and senders/recipients
  const whitelist = undefined;
  const relayer = new HyperlaneRelayer({ core, whitelist });

  try {
    const contents = await readFile(CACHE_PATH, 'utf-8');
    const data = JSON.parse(contents);
    const cache = RelayerCacheSchema.parse(data);
    relayer.hydrate(cache);
    console.log(`Relayer cache loaded from ${CACHE_PATH}`);
  } catch (e) {
    console.error(`Failed to load cache from ${CACHE_PATH}`);
  }

  relayer.start();

  process.once('SIGINT', async () => {
    relayer.stop();

    const cache = JSON.stringify(relayer.cache);
    await writeFile(CACHE_PATH, cache, 'utf-8');
    console.log(`Relayer cache saved to ${CACHE_PATH}`);

    process.exit(0);
  });
}

main();
