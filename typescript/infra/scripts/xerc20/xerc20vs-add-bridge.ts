import { join } from 'path';

import { EvmXERC20VSAdapter } from '@hyperlane-xyz/sdk';
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
    try {
      const {
        xERC20Address,
        bridgeAddress,
        bufferCap,
        rateLimitPerSecond,
        decimal,
      } = bridgesConfig[chain];

      const xERC20Adapter = new EvmXERC20VSAdapter(
        chain,
        multiProtocolProvider,
        {
          token: xERC20Address,
        },
      );

      // scale the numeric by the decimal
      const bufferCapScaled = BigInt(bufferCap) * 10n ** BigInt(decimal);
      const rateLimitScaled =
        BigInt(rateLimitPerSecond) * 10n ** BigInt(decimal);

      const tx = await xERC20Adapter.populateAddBridgeTx({
        bufferCap: bufferCapScaled,
        rateLimitPerSecond: rateLimitScaled,
        bridge: bridgeAddress,
      });

      const signer = envMultiProvider.getSigner(chain);

      rootLogger.info(`Sending transaction for chain ${chain}...`);
      const txResponse = await signer.sendTransaction(tx);
      const txReceipt = await envMultiProvider.handleTx(chain, txResponse);

      rootLogger.info(`[${chain}] Transaction Receipt:`, txReceipt);
    } catch (error) {
      rootLogger.info(`[${chain}] Error adding bridge:`, error);
    }
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
