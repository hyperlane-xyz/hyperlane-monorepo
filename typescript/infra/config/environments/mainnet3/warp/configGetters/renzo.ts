import { parseEther } from 'ethers/lib/utils.js';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmType,
  MultisigConfig,
  TokenType,
  buildAggregationIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { Address, assert, symmetricDifference } from '@hyperlane-xyz/utils';

import { getEnvironmentConfig } from '../../../../../scripts/core-utils.js';
import { getRegistry as getMainnet3Registry } from '../../chains.js';

const lockboxChain = 'ethereum';
// over the default 100k to account for xerc20 gas + ISM overhead over the default ISM https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/49f41d9759fd515bfd89e6e22e799c41b27b4119/typescript/sdk/src/router/GasRouterDeployer.ts#L14
const warpRouteOverheadGas = 200_000;
export const MAX_PROTOCOL_FEE = parseEther('100').toString(); // Changing this will redeploy the PROTOCOL_FEE hook

// Used to stabilize the protocolFee of ProtocolHook upon deployment such that we don't get diffs every time tokenPrices.json is updated
export const renzoTokenPrices: ChainMap<string> = {
  base: '3157.26', // ETH
  ethereum: '3157.26', // ETH
  unichain: '2602.66', // ETH
};

export function getProtocolFee(chain: ChainName) {
  const price = renzoTokenPrices[chain];
  assert(price, `No price for chain ${chain}`);
  return (0.5 / Number(price)).toFixed(10).toString(); // ~$0.50 USD
}

// Fetched using: hyperlane warp check --warpRouteId EZETH/renzo-prod
// Set After deployment
const chainProtocolFee: Record<ChainName, string> = {
  base: '400000000000000',
  ethereum: '400000000000000',
  unichain: '400000000000000',
};

export function getRenzoHook(
  defaultHook: Address,
  chain: ChainName,
  owner: Address,
): HookConfig {
  return {
    type: HookType.AGGREGATION,
    hooks: [
      defaultHook,
      {
        type: HookType.PROTOCOL_FEE,
        owner: owner,
        beneficiary: owner,

        // Use hardcoded, actual onchain fees, or fallback to fee calculation
        protocolFee:
          chainProtocolFee[chain] ??
          parseEther(getProtocolFee(chain)).toString(),
        maxProtocolFee: MAX_PROTOCOL_FEE,
      },
    ],
  };
}

export function getRenzoWarpConfigGenerator(params: {
  chainsToDeploy: string[];
  validators: ChainMap<MultisigConfig>;
  safes: Record<string, string>;
  xERC20Addresses: Record<string, string>;
  xERC20Lockbox: string;
  tokenPrices: ChainMap<string>;
  chainOwnerOverrides?: ChainMap<Partial<{ proxyAdmin: string }>>;
}) {
  const {
    chainsToDeploy,
    validators,
    safes,
    xERC20Addresses,
    xERC20Lockbox,
    tokenPrices,
    chainOwnerOverrides,
  } = params;
  return async (): Promise<ChainMap<HypTokenRouterConfig>> => {
    const config = getEnvironmentConfig('mainnet3');
    const multiProvider = await config.getMultiProvider();
    const registry = await getMainnet3Registry();

    const validatorDiff = symmetricDifference(
      new Set(chainsToDeploy),
      new Set(Object.keys(validators)),
    );
    const safeDiff = symmetricDifference(
      new Set(chainsToDeploy),
      new Set(Object.keys(safes)),
    );
    const xERC20Diff = symmetricDifference(
      new Set(chainsToDeploy),
      new Set(Object.keys(xERC20Addresses)),
    );
    const tokenPriceDiff = symmetricDifference(
      new Set(chainsToDeploy),
      new Set(Object.keys(tokenPrices)),
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
        `chainsToDeploy !== safeDiff, diff is ${Array.from(safeDiff).join(
          ', ',
        )}`,
      );
    }
    if (xERC20Diff.size > 0) {
      throw new Error(
        `chainsToDeploy !== xERC20Diff, diff is ${Array.from(xERC20Diff).join(
          ', ',
        )}`,
      );
    }

    if (tokenPriceDiff.size > 0) {
      throw new Error(
        `chainsToDeploy !== tokenPriceDiff, diff is ${Array.from(
          tokenPriceDiff,
        ).join(', ')}`,
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
            const ret: HypTokenRouterConfig = {
              isNft: false,
              type:
                chain === lockboxChain
                  ? TokenType.XERC20Lockbox
                  : TokenType.XERC20,
              token:
                chain === lockboxChain ? xERC20Lockbox : xERC20Addresses[chain],
              owner: safes[chain],
              gas: warpRouteOverheadGas,
              mailbox,
              interchainSecurityModule: {
                type: IsmType.AGGREGATION,
                threshold: 2,
                modules: [
                  {
                    type: IsmType.ROUTING,
                    owner: safes[chain],
                    domains: buildAggregationIsmConfigs(
                      chain,
                      chainsToDeploy,
                      validators,
                    ),
                  },
                  {
                    type: IsmType.FALLBACK_ROUTING,
                    domains: {},
                    owner: safes[chain],
                  },
                ],
              },
              hook: getRenzoHook(defaultHook, chain, safes[chain]),
            };

            if (chainOwnerOverrides?.[chain]) {
              ret.ownerOverrides = chainOwnerOverrides[chain];
            }

            return [chain, ret];
          },
        ),
      ),
    );

    return tokenConfig;
  };
}
