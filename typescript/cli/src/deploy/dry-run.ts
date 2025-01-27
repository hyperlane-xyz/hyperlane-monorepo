import {
  ANVIL_RPC_METHODS,
  MultiProvider,
  getLocalProvider,
  resetFork,
  setFork,
} from '@hyperlane-xyz/sdk';
import { toUpperCamelCase } from '@hyperlane-xyz/utils';

import { logGray, logGreen, warnYellow } from '../logger.js';
import { ENV } from '../utils/env.js';

/**
 * Forks a provided network onto MultiProvider
 * @param multiProvider the MultiProvider to be prepared
 * @param chains the chain selection passed-in by the user
 */
export async function forkNetworkToMultiProvider(
  multiProvider: MultiProvider,
  chain: string,
) {
  multiProvider = multiProvider.extendChainMetadata({
    [chain]: { blocks: { confirmations: 1 } },
  });

  await setFork(multiProvider, chain);
  return multiProvider;
}

/**
 * Ensures an anvil node is running locally.
 */
export async function verifyAnvil() {
  logGray('🔎 Verifying anvil node is running...');

  const provider = getLocalProvider(ENV.ANVIL_IP_ADDR, ENV.ANVIL_PORT);
  try {
    await provider.send(ANVIL_RPC_METHODS.NODE_INFO, []);
  } catch (error: any) {
    if (error.message.includes('missing response'))
      throw new Error(`No active anvil node detected.
\tPlease run \`anvil\` in a separate instance.`);
  }

  logGreen('✅ Successfully verified anvil node is running');
}

/**
 * Evaluates if an error is related to the current dry-run.
 * @param error the thrown error
 * @param dryRun the chain name to execute the dry-run on
 */
export function evaluateIfDryRunFailure(error: any, dryRun: string) {
  if (dryRun && error.message.includes('call revert exception'))
    warnYellow(
      '⛔️ [dry-run] The current RPC may not support forking. Please consider using a different RPC provider.',
    );
}

export async function completeDryRun(command: string) {
  await resetFork();

  logGreen(`✅ ${toUpperCamelCase(command)} dry-run completed successfully`);
}
