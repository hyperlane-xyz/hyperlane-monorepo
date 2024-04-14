import { MultiProvider } from '@hyperlane-xyz/sdk';

import { logGray, logGreen, warnYellow } from '../logger.js';
import { ANVIL_RPC_METHODS, getLocalProvider, setFork } from '../utils/fork.js';

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
    [chain]: { blocks: { confirmations: 0 } },
  });

  await setFork(multiProvider, chain);
}

/**
 * Ensures an anvil node is running locally.
 */
export async function verifyAnvil() {
  logGray('Verifying anvil node is running...');

  const provider = getLocalProvider();
  try {
    await provider.send(ANVIL_RPC_METHODS.NODE_INFO, []);
  } catch (error: any) {
    if (error.message.includes('missing response'))
      throw new Error(`No active anvil node detected.
\tPlease run \`anvil\` in a separate instance.`);
  }

  logGreen('Successfully verified anvil node is running ✅');
}

/**
 * Evaluates if an error is related to the current dry-run.
 * @param error the thrown error
 * @param dryRun whether or not the current command is being dry-run
 */
export function evaluateIfDryRunFailure(error: any, dryRun: boolean) {
  if (dryRun && error.message.includes('call revert exception'))
    warnYellow(
      '⛔️ [dry-run] The current RPC may not support forking. Please consider using a different RPC provider.',
    );
}
