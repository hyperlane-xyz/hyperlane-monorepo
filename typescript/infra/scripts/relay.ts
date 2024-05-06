import { HyperlaneRelayer } from '@hyperlane-xyz/sdk';

import { readFile, writeFile } from 'fs/promises';

import { getArgs } from './agent-utils.js';
import { getHyperlaneCore } from './core-utils.js';

const CACHE_PATH = process.env.RELAYER_CACHE ?? './relayer-cache.json';

async function main() {
  const { environment } = await getArgs().argv;
  const { core } = await getHyperlaneCore(environment);
  const relayer = new HyperlaneRelayer(core);

  const chains = ['optimism', 'arbitrum', 'polygon', 'celo', 'base'];

  try {
    const contents = await readFile(CACHE_PATH, 'utf-8');
    const cache = JSON.parse(contents);
    console.log(`Relayer cache loaded from ${CACHE_PATH}`);

    await relayer.hydrate(cache);
  } catch (e) {
    console.error(`Failed to load cache from ${CACHE_PATH}`);
  }

  relayer.start(chains);

  process.once('SIGINT', async () => {
    relayer.stop(chains);

    const cache = JSON.stringify(relayer.cache);
    await writeFile(CACHE_PATH, cache, 'utf-8');
    console.log(`Relayer cache saved to ${CACHE_PATH}`);

    process.exit(0);
  });
}

main();
