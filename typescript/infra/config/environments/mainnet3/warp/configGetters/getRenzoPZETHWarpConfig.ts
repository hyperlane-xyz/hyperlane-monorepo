import {
  ChainMap,
  IsmType,
  TokenRouterConfig,
  TokenType,
  buildAggregationIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { symmetricDifference } from '@hyperlane-xyz/utils';

import { getRegistry as getMainnet3Registry } from '../../chains.js';

const lockbox = '0xbC5511354C4A9a50DE928F56DB01DD327c4e56d5';
const xERC20 = '0x9cb41CD74D01ae4b4f640EC40f7A60cA1bCF83E7';
const lockboxChain = 'ethereum';
// over the default 100k to account for xerc20 gas + ISM overhead over the default ISM https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/49f41d9759fd515bfd89e6e22e799c41b27b4119/typescript/sdk/src/router/GasRouterDeployer.ts#L14
const warpRouteOverheadGas = 200_000;

const chainsToDeploy = ['ethereum', 'zircuit'];

const ezEthValidators = {
  ethereum: {
    threshold: 1,
    validators: [
      '0x1fd889337f60986aa57166bc5ac121efd13e4fdd', // Everclear
      '0xc7f7b94a6baf2fffa54dfe1dde6e5fcbb749e04f', // Renzo
    ],
  },
  zircuit: {
    threshold: 1,
    validators: [
      '0x1da9176c2ce5cc7115340496fa7d1800a98911ce', // Renzo
      '0x7ac6584c068eb2a72d4db82a7b7cd5ab34044061', // luganodes
    ],
  },
};

const ezEthSafes: Record<string, string> = {
  ethereum: '0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A',
  zircuit: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
};

export const getRenzoPZETHWarpConfig = async (): Promise<
  ChainMap<TokenRouterConfig>
> => {
  const registry = await getMainnet3Registry();

  const validatorDiff = symmetricDifference(
    new Set(chainsToDeploy),
    new Set(Object.keys(ezEthValidators)),
  );
  const safeDiff = symmetricDifference(
    new Set(chainsToDeploy),
    new Set(Object.keys(ezEthSafes)),
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

  const tokenConfig = Object.fromEntries<TokenRouterConfig>(
    await Promise.all(
      chainsToDeploy.map(
        async (chain): Promise<[string, TokenRouterConfig]> => {
          const ret: [string, TokenRouterConfig] = [
            chain,
            {
              isNft: false,
              type:
                chain === lockboxChain
                  ? TokenType.XERC20Lockbox
                  : TokenType.XERC20,
              token: chain === lockboxChain ? lockbox : xERC20,
              owner: ezEthSafes[chain],
              gas: warpRouteOverheadGas,
              mailbox: (await registry.getChainAddresses(chain))!.mailbox,
              interchainSecurityModule: {
                type: IsmType.AGGREGATION,
                threshold: 2,
                modules: [
                  {
                    type: IsmType.ROUTING,
                    owner: ezEthSafes[chain],
                    domains: buildAggregationIsmConfigs(
                      chain,
                      chainsToDeploy,
                      ezEthValidators,
                    ),
                  },
                  {
                    type: IsmType.FALLBACK_ROUTING,
                    domains: {},
                    owner: ezEthSafes[chain],
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
