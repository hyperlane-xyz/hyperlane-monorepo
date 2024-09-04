import { setRpcUrlsInteractive } from '../../src/utils/rpcUrls.js';
import {
  assertCorrectKubeContext,
  getArgs,
  withChainsRequired,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment, chains } = await withChainsRequired(getArgs())
    // For ease of use and backward compatibility, we allow the `chain` argument to be
    // singular or plural.
    .alias('chain', 'chains').argv;

  await assertCorrectKubeContext(getEnvironmentConfig(environment));

  if (!chains || chains.length === 0) {
    console.error('No chains provided, Exiting.');
    process.exit(1);
  }

  for (const chain of chains) {
    console.log(`Setting RPC URLs for chain: ${chain}`);
    await setRpcUrlsInteractive(environment, chain);
  }
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
