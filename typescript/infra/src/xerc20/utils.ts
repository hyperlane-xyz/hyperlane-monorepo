import chalk from 'chalk';
import { join } from 'path';

import {
  EvmXERC20VSAdapter,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { getInfraPath } from '../utils/utils.js';

export const XERC20_BRIDGES_CONFIG_PATH = join(
  getInfraPath(),
  'scripts/xerc20/config.yaml',
);

export interface BridgeConfig {
  xERC20Address: Address;
  bridgeAddress: Address;
  decimal: number;
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
        `[${chain}] Sending addBridge transaction to ${bridgeAddress}...`,
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

  const bufferCapScaled = BigInt(bufferCap) * 10n ** BigInt(decimal);
  await updateBufferCap(
    chain,
    bufferCapScaled,
    currentBufferCap,
    bridgeAddress,
    xERC20Adapter,
    envMultiProvider,
  );

  const rateLimitScaled = BigInt(rateLimitPerSecond) * 10n ** BigInt(decimal);
  await updateRateLimitPerSecond(
    chain,
    rateLimitScaled,
    currentRateLimitPerSecond,
    bridgeAddress,
    xERC20Adapter,
    envMultiProvider,
  );
}

async function updateBufferCap(
  chain: string,
  newBufferCap: bigint,
  currentBufferCap: bigint,
  bridgeAddress: Address,
  xERC20Adapter: EvmXERC20VSAdapter,
  multiProvider: MultiProvider,
) {
  if (newBufferCap === currentBufferCap) {
    rootLogger.info(
      chalk.green(`[${chain}] Buffer cap is already set to the desired value`),
    );
    return;
  }

  try {
    const tx = await xERC20Adapter.populateSetBufferCapTx({
      newBufferCap,
      bridge: bridgeAddress,
    });

    rootLogger.info(
      chalk.gray(
        `[${chain}] Updating buffer cap from ${currentBufferCap} to ${newBufferCap}...`,
      ),
    );
    const signer = multiProvider.getSigner(chain);
    const txResponse = await signer.sendTransaction(tx);
    const txReceipt = await multiProvider.handleTx(chain, txResponse);
    rootLogger.info(
      chalk.green(
        `[${chain}] Transaction confirmed: ${txReceipt.transactionHash}`,
      ),
    );
  } catch (error) {
    rootLogger.error(chalk.red(`[${chain}] Error updating buffer cap:`, error));
  }
}

async function updateRateLimitPerSecond(
  chain: string,
  newRateLimitPerSecond: bigint,
  currentRateLimitPerSecond: bigint,
  bridgeAddress: Address,
  xERC20Adapter: EvmXERC20VSAdapter,
  multiProvider: MultiProvider,
) {
  if (newRateLimitPerSecond === currentRateLimitPerSecond) {
    rootLogger.info(
      chalk.green(
        `[${chain}] Rate limit per second is already set to the desired value`,
      ),
    );
    return;
  }

  try {
    const tx = await xERC20Adapter.populateSetRateLimitPerSecondTx({
      newRateLimitPerSecond,
      bridge: bridgeAddress,
    });

    rootLogger.info(
      chalk.gray(
        `[${chain}] Updating rate limit per second from ${currentRateLimitPerSecond} to ${newRateLimitPerSecond}...`,
      ),
    );
    const signer = multiProvider.getSigner(chain);
    const txResponse = await signer.sendTransaction(tx);
    const txReceipt = await multiProvider.handleTx(chain, txResponse);
    rootLogger.info(
      chalk.green(
        `[${chain}] Transaction confirmed: ${txReceipt.transactionHash}`,
      ),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(`[${chain}] Error updating rate limit per second:`, error),
    );
  }
}
