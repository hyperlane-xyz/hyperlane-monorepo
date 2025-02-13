import { join } from 'path';

import { EvmXERC20VSAdapter, MultiProvider } from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { getInfraPath, readYaml } from '../../src/utils/utils.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

interface BridgeConfig {
  xERC20Address: Address;
  bridgeAddress: Address;
  decimal: number;
  bufferCap: number;
  rateLimitPerSecond: number;
}

const CONFIG_PATH = join(getInfraPath(), 'scripts/xerc20/config.yaml');

async function main() {
  const { environment } = await getArgs().argv;

  const bridgesConfig = readYaml<Record<string, BridgeConfig>>(CONFIG_PATH);

  if (!bridgesConfig) {
    throw new Error(`Could not read or parse config at path: ${CONFIG_PATH}`);
  }

  const envConfig = getEnvironmentConfig(environment);
  const multiProtocolProvider = await envConfig.getMultiProtocolProvider();
  const envMultiProvider = await envConfig.getMultiProvider();
  for (const chain of Object.keys(bridgesConfig)) {
    const {
      xERC20Address,
      bridgeAddress,
      bufferCap,
      rateLimitPerSecond,
      decimal,
    } = bridgesConfig[chain];

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
      `Buffer cap for ${chain} is already set to the desired value`,
    );
    return;
  }

  console.log(
    `Updating buffer cap for ${chain} from ${currentBufferCap} to ${newBufferCap}...`,
  );

  try {
    const tx = await xERC20Adapter.populateSetBufferCapTx({
      newBufferCap,
      bridge: bridgeAddress,
    });

    rootLogger.info(`Sending transaction for chain ${chain}...`);
    const signer = multiProvider.getSigner(chain);
    const txResponse = await signer.sendTransaction(tx);
    const txReceipt = await multiProvider.handleTx(chain, txResponse);

    rootLogger.info(`[${chain}] Transaction Receipt:`, txReceipt);
  } catch (error) {
    rootLogger.error(`[${chain}] Error updating buffer cap:`, error);
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
      `Rate limit per second for ${chain} is already set to the desired value`,
    );
    return;
  }

  console.log(
    `Updating rate limit per second for ${chain} from ${currentRateLimitPerSecond} to ${newRateLimitPerSecond}...`,
  );

  try {
    const tx = await xERC20Adapter.populateSetRateLimitPerSecondTx({
      newRateLimitPerSecond,
      bridge: bridgeAddress,
    });

    rootLogger.info(`Sending transaction for chain ${chain}...`);
    const signer = multiProvider.getSigner(chain);
    const txResponse = await signer.sendTransaction(tx);
    const txReceipt = await multiProvider.handleTx(chain, txResponse);

    rootLogger.info(`[${chain}] Transaction Receipt:`, txReceipt);
  } catch (error) {
    rootLogger.error(`[${chain}] Error updating rate limit per second:`, error);
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
