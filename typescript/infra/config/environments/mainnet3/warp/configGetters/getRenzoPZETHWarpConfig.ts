import { Mailbox__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  HypTokenRouterConfig,
  IsmType,
  TokenType,
  buildAggregationIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { assert, symmetricDifference } from '@hyperlane-xyz/utils';

import { getEnvironmentConfig } from '../../../../../scripts/core-utils.js';
import { getRegistry as getMainnet3Registry } from '../../chains.js';

import {
  ezEthSafes,
  ezEthValidators,
  getRenzoHook,
} from './getRenzoEZETHWarpConfig.js';

const lockbox = '0xbC5511354C4A9a50DE928F56DB01DD327c4e56d5';
const xERC20 = '0x9cb41CD74D01ae4b4f640EC40f7A60cA1bCF83E7';
const lockboxChain = 'ethereum';
// over the default 100k to account for xerc20 gas + ISM overhead over the default ISM https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/49f41d9759fd515bfd89e6e22e799c41b27b4119/typescript/sdk/src/router/GasRouterDeployer.ts#L14
const warpRouteOverheadGas = 200_000;

const chainsToDeploy = ['ethereum', 'swell', 'zircuit'];

const pzEthValidators = {
  ethereum: ezEthValidators.ethereum,
  zircuit: ezEthValidators.zircuit,
  swell: ezEthValidators.swell,
};

const pzEthSafes: Record<string, string> = {
  ethereum: ezEthSafes.ethereum,
  zircuit: ezEthSafes.zircuit,
  swell: ezEthSafes.swell,
};

const existingProxyAdmins: ChainMap<{ address: string; owner: string }> = {
  ethereum: {
    address: '0x4f4671Ce69c9af15e33eB7Cf6D1358d1B39Af3bF',
    owner: '0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A',
  },
  zircuit: {
    address: '0x8b789B4A56675240c9f0985B467752b870c75711',
    owner: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
  },
};

export const getRenzoPZETHWarpConfig = async (): Promise<
  ChainMap<HypTokenRouterConfig>
> => {
  const config = getEnvironmentConfig('mainnet3');
  const multiProvider = await config.getMultiProvider();
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
          const addresses = await registry.getChainAddresses(chain);
          assert(addresses, 'No addresses in Registry');
          const { mailbox } = addresses;

          const mailboxContract = Mailbox__factory.connect(
            mailbox,
            multiProvider.getProvider(chain),
          );
          const defaultHook = await mailboxContract.defaultHook();
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
              mailbox,
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
              hook: getRenzoHook(defaultHook, chain),
              proxyAdmin: existingProxyAdmins[chain],
            },
          ];

          return ret;
        },
      ),
    ),
  );

  return tokenConfig;
};
