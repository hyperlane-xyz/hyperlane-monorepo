import chalk from 'chalk';
import { PopulatedTransaction } from 'ethers';
import { join } from 'path';

import {
  EvmXERC20VSAdapter,
  MultiProtocolProvider,
  MultiProvider,
  canProposeSafeTransactions,
} from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { SafeMultiSend } from '../govern/multisend.js';
import { getInfraPath } from '../utils/utils.js';

export const XERC20_BRIDGES_CONFIG_PATH = join(
  getInfraPath(),
  'scripts/xerc20/config.yaml',
);

export interface BridgeConfig {
  xERC20Address: Address;
  bridgeAddress: Address;
  decimal: number;
  owner: Address;
  bufferCap: number;
  rateLimitPerSecond: number;
}

export async function addBridgeToChain({
  chain,
  bridgeConfig,
  multiProtocolProvider,
  envMultiProvider,
}: {
  chain: string;
  bridgeConfig: BridgeConfig;
  multiProtocolProvider: MultiProtocolProvider;
  envMultiProvider: MultiProvider;
}) {
  const {
    xERC20Address,
    bridgeAddress,
    bufferCap,
    rateLimitPerSecond,
    decimal,
  } = bridgeConfig;

  try {
    const xERC20Adapter = new EvmXERC20VSAdapter(chain, multiProtocolProvider, {
      token: xERC20Address,
    });

    const bufferCapScaled = BigInt(bufferCap) * 10n ** BigInt(decimal);
    const rateLimitScaled = BigInt(rateLimitPerSecond) * 10n ** BigInt(decimal);

    const rateLimits = await xERC20Adapter.getRateLimits(bridgeAddress);
    if (rateLimits.rateLimitPerSecond) {
      rootLogger.warn(
        chalk.yellow(
          `[${chain}] Skipping addBridge as rate limits already set for bridge: ${bridgeAddress}.`,
        ),
      );
      return;
    }

    const tx = await xERC20Adapter.populateAddBridgeTx({
      bufferCap: bufferCapScaled,
      rateLimitPerSecond: rateLimitScaled,
      bridge: bridgeAddress,
    });

    rootLogger.info(
      chalk.gray(
        `[${chain}] Sending addBridge transaction to ${xERC20Address}...`,
      ),
    );
    const signer = envMultiProvider.getSigner(chain);
    const txResponse = await signer.sendTransaction(tx);
    const txReceipt = await envMultiProvider.handleTx(chain, txResponse);
    rootLogger.info(
      chalk.green(
        `[${chain}] Transaction confirmed: ${txReceipt.transactionHash}`,
      ),
    );
  } catch (error) {
    rootLogger.error(chalk.red(`[${chain}] Error adding bridge:`, error));
    throw { chain, error };
  }
}

export async function updateChainLimits({
  chain,
  bridgeConfig,
  multiProtocolProvider,
  envMultiProvider,
}: {
  chain: string;
  bridgeConfig: BridgeConfig;
  multiProtocolProvider: MultiProtocolProvider;
  envMultiProvider: MultiProvider;
}) {
  const {
    xERC20Address,
    bridgeAddress,
    owner,
    bufferCap,
    rateLimitPerSecond,
    decimal,
  } = bridgeConfig;
  const xERC20Adapter = new EvmXERC20VSAdapter(chain, multiProtocolProvider, {
    token: xERC20Address,
  });

  const {
    rateLimitPerSecond: currentRateLimitPerSecond,
    bufferCap: currentBufferCap,
  } = await xERC20Adapter.getRateLimits(bridgeAddress);

  const bufferCapTx = await prepareBufferCapTx(
    chain,
    xERC20Adapter,
    bufferCap,
    currentBufferCap,
    decimal,
    bridgeAddress,
  );

  const rateLimitTx = await prepareRateLimitTx(
    chain,
    xERC20Adapter,
    rateLimitPerSecond,
    currentRateLimitPerSecond,
    decimal,
    bridgeAddress,
  );

  const txsToSend = [bufferCapTx, rateLimitTx].filter(
    Boolean,
  ) as PopulatedTransaction[];
  if (txsToSend.length === 0) {
    rootLogger.info(chalk.yellow(`[${chain}] Nothing to update`));
    return;
  }

  const signer = envMultiProvider.getSigner(chain);
  const proposerAddress = await signer.getAddress();
  const isSafeOwner = await checkSafeOwner(
    proposerAddress,
    chain,
    envMultiProvider,
    owner,
  );

  if (isSafeOwner) {
    await sendAsSafeMultiSend(chain, owner, envMultiProvider, txsToSend);
  } else {
    await sendAsEOATransactions(chain, envMultiProvider, txsToSend);
  }
}

async function prepareBufferCapTx(
  chain: string,
  adapter: EvmXERC20VSAdapter,
  newBufferCap: number,
  currentBufferCap: bigint,
  decimal: number,
  bridgeAddress: Address,
): Promise<PopulatedTransaction | null> {
  const bufferCapScaled = BigInt(newBufferCap) * 10n ** BigInt(decimal);
  if (bufferCapScaled === currentBufferCap) {
    rootLogger.info(
      chalk.green(`[${chain}] Buffer cap is already set to the desired value`),
    );
    return null;
  }

  rootLogger.info(
    chalk.gray(
      `[${chain}] Preparing buffer cap update: ${currentBufferCap} → ${bufferCapScaled}`,
    ),
  );
  return adapter.populateSetBufferCapTx({
    newBufferCap: bufferCapScaled,
    bridge: bridgeAddress,
  });
}

async function prepareRateLimitTx(
  chain: string,
  adapter: EvmXERC20VSAdapter,
  newRateLimitPerSecond: number,
  currentRateLimitPerSecond: bigint,
  decimal: number,
  bridgeAddress: Address,
): Promise<PopulatedTransaction | null> {
  const rateLimitScaled =
    BigInt(newRateLimitPerSecond) * 10n ** BigInt(decimal);
  if (rateLimitScaled === currentRateLimitPerSecond) {
    rootLogger.info(
      chalk.green(
        `[${chain}] Rate limit per second is already set to the desired value`,
      ),
    );
    return null;
  }

  rootLogger.info(
    chalk.gray(
      `[${chain}] Preparing rate limit update: ${currentRateLimitPerSecond} → ${rateLimitScaled}`,
    ),
  );
  return adapter.populateSetRateLimitPerSecondTx({
    newRateLimitPerSecond: rateLimitScaled,
    bridge: bridgeAddress,
  });
}

async function checkSafeOwner(
  proposer: Address,
  chain: string,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<boolean> {
  try {
    return await canProposeSafeTransactions(
      proposer,
      chain,
      multiProvider,
      safeAddress,
    );
  } catch {
    return false;
  }
}

async function sendAsSafeMultiSend(
  chain: string,
  safeAddress: Address,
  multiProvider: MultiProvider,
  transactions: PopulatedTransaction[],
) {
  rootLogger.info(
    chalk.gray(
      `[${chain}] Using SafeMultiSend for ${transactions.length} transaction(s) to ${safeAddress}...`,
    ),
  );

  const safeMultiSend = new SafeMultiSend(multiProvider, chain, safeAddress);
  const multiSendTxs = transactions.map((tx) => {
    if (!tx.to || !tx.data) {
      throw new Error(
        `[${chain}] Populated transaction missing 'to' or 'data'`,
      );
    }
    return { to: tx.to, data: tx.data };
  });

  await safeMultiSend.sendTransactions(multiSendTxs);
  rootLogger.info(
    chalk.green(`[${chain}] Safe multi-send transaction(s) submitted.`),
  );
}

async function sendAsEOATransactions(
  chain: string,
  multiProvider: MultiProvider,
  transactions: PopulatedTransaction[],
) {
  rootLogger.info(
    chalk.gray(
      `[${chain}] Sending ${transactions.length} transaction(s) via EOA...`,
    ),
  );

  const signer = multiProvider.getSigner(chain);
  for (const tx of transactions) {
    rootLogger.info(
      chalk.gray(`[${chain}] Sending EOA transaction to ${tx.to}...`),
    );
    const txResponse = await signer.sendTransaction(tx);
    const txReceipt = await multiProvider.handleTx(chain, txResponse);

    rootLogger.info(
      chalk.green(
        `[${chain}] Transaction confirmed: ${txReceipt.transactionHash}`,
      ),
    );
  }
}
