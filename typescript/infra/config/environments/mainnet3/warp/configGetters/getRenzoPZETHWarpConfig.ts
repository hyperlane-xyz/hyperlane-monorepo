import {
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  TokenType,
  buildAggregationIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { symmetricDifference } from '@hyperlane-xyz/utils';

import { getRegistry as getMainnet3Registry } from '../../chains.js';

import { ezEthSafes, ezEthValidators } from './getRenzoEZETHWarpConfig.js';

const lockbox = '0xbC5511354C4A9a50DE928F56DB01DD327c4e56d5';
const xERC20 = '0x9cb41CD74D01ae4b4f640EC40f7A60cA1bCF83E7';
const lockboxChain = 'ethereum';
// over the default 100k to account for xerc20 gas + ISM overhead over the default ISM https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/49f41d9759fd515bfd89e6e22e799c41b27b4119/typescript/sdk/src/router/GasRouterDeployer.ts#L14
const warpRouteOverheadGas = 200_000;

const chainsToDeploy = ['ethereum', 'zircuit'];

const pzEthValidators = {
  ethereum: ezEthValidators.ethereum,
  zircuit: ezEthValidators.zircuit,
};

const pzEthSafes: Record<string, string> = {
  ethereum: ezEthSafes.ethereum,
  zircuit: ezEthSafes.zircuit,
};

export const getRenzoPZETHWarpConfig = async (): Promise<
  ChainMap<HypTokenRouterConfig>
> => {
  const registry = await getMainnet3Registry();

  const validatorDiff = symmetricDifference(
    new Set(chainsToDeploy),
    new Set(Object.keys(pzEthValidators)),
  );
  const safeDiff = symmetricDifference(
    new Set(chainsToDeploy),
    new Set(Object.keys(pzEthSafes)),
  );
  if (validatorDiff.size > 0) {
    throw new Error(
      `chainsToDeploy !== validatorConfig, diff is ${Array.from(
        validatorDiff,
      ).join(', ')}`,
    );
  }
  if (safeDiff.size > 0) {
    throw new Error(
      `chainsToDeploy !== safeDiff, diff is ${Array.from(safeDiff).join(', ')}`,
    );
  }

  const tokenConfig = Object.fromEntries<HypTokenRouterConfig>(
    await Promise.all(
      chainsToDeploy.map(
        async (chain): Promise<[string, HypTokenRouterConfig]> => {
          const ret: [string, HypTokenRouterConfig] = [
            chain,
            {
              isNft: false,
              type:
                chain === lockboxChain
                  ? TokenType.XERC20Lockbox
                  : TokenType.XERC20,
              token: chain === lockboxChain ? lockbox : xERC20,
              owner: pzEthSafes[chain],
              gas: warpRouteOverheadGas,
              mailbox: (await registry.getChainAddresses(chain))!.mailbox,
              interchainSecurityModule: {
                type: IsmType.AGGREGATION,
                threshold: 2,
                modules: [
                  {
                    type: IsmType.ROUTING,
                    owner: pzEthSafes[chain],
                    domains: buildAggregationIsmConfigs(
                      chain,
                      chainsToDeploy,
                      pzEthValidators,
                    ),
                  },
                  {
                    type: IsmType.FALLBACK_ROUTING,
                    domains: {},
                    owner: pzEthSafes[chain],
                  },
                ],
              },
            },
          ];

          return ret;
        },
      ),
    ),
  );

  return tokenConfig;
};
