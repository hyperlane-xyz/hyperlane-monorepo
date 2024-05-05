import { HyperlaneRelayer } from '@hyperlane-xyz/sdk';

import { getArgs } from './agent-utils.js';
import { getHyperlaneCore } from './core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const { core } = await getHyperlaneCore(environment);
  const relayer = new HyperlaneRelayer(core);
  await relayer.relay();
}

main();
