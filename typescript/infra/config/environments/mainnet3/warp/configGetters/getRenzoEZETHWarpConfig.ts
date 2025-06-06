import { parseEther } from 'ethers/lib/utils.js';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import {
  AggregationIsmConfig,
  ChainMap,
  ChainName,
  HookConfig,
  HookType,
  HypTokenRouterConfig,
  IsmType,
  MultisigConfig,
  RoutingIsmConfig,
  TokenType,
  buildAggregationIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { Address, assert, symmetricDifference } from '@hyperlane-xyz/utils';

import { getEnvironmentConfig } from '../../../../../scripts/core-utils.js';
import { getGnosisSafeBuilderStrategyConfigGenerator } from '../../../utils.js';
import { getRegistry as getMainnet3Registry } from '../../chains.js';

export const ezEthChainsToDeploy = [
  'arbitrum',
  'optimism',
  'base',
  'blast',
  'bsc',
  'mode',
  'linea',
  'ethereum',
  'fraxtal',
  'zircuit',
  'taiko',
  'sei',
  'swell',
  'unichain',
  'berachain',
  'worldchain',
];
export const MAX_PROTOCOL_FEE = parseEther('100').toString(); // Changing this will redeploy the PROTOCOL_FEE hook

// Used to stabilize the protocolFee of ProtocolHook such that we don't get diffs every time tokenPrices.json is updated
export const renzoTokenPrices: ChainMap<string> = {
  arbitrum: '3157.26',
  optimism: '3157.26',
  base: '3157.26',
  blast: '3157.26',
  bsc: '673.59',
  mode: '3157.26',
  linea: '3157.26',
  ethereum: '3157.26',
  fraxtal: '3168.75',
  zircuit: '3157.26',
  taiko: '3157.26',
  sei: '0.354988',
  swell: '3157.26',
  unichain: '2602.66',
  berachain: '10',
  worldchain: '1599.53',
};
export function getProtocolFee(chain: ChainName) {
  const price = renzoTokenPrices[chain];
  assert(price, `No price for chain ${chain}`);
  return (0.5 / Number(price)).toFixed(10).toString(); // ~$0.50 USD
}

// Fetched using: hyperlane warp check --warpRouteId EZETH/renzo-prod
const chainProtocolFee: Record<ChainName, string> = {
  arbitrum: '400000000000000',
  base: '400000000000000',
  blast: '129871800000000',
  bsc: '1400000000000000',
  ethereum: '400000000000000',
  fraxtal: '400000000000000',
  linea: '400000000000000',
  mode: '400000000000000',
  optimism: '400000000000000',
  sei: '798889224400000000',
  swell: '129871800000000',
  taiko: '400000000000000',
  unichain: '400000000000000',
  worldchain: '400000000000000',
  zircuit: '400000000000000',
};

export function getRenzoHook(params: {
  defaultHook: Address;
  origin: ChainName;
  destinationChains: ChainName[];
  owner: Address;
  useLegacyRoutingHook: boolean;
}): HookConfig {
  const {
    defaultHook,
    origin,
    destinationChains,
    owner,
    useLegacyRoutingHook,
  } = params;

  let routingHook: HookConfig;

  if (useLegacyRoutingHook) {
    // Currently, most of the Hook configs are using the default hook address.
    // This is here to allow for incremental rollout of the default hook config for other (PZETH, REZ) configs that depend on this Getter.
    // TODO: Remove this when we replace all the default hook address with HookType.MAILBOX_DEFAULT
    routingHook = defaultHook;
  } else {
    // If origin is blast, use default hook (allows for outbound to all existing chains).
    // If origin is other chains, use default hook to route to all existing destinations, except blast.
    routingHook =
      origin === 'blast'
        ? {
            type: HookType.MAILBOX_DEFAULT,
          }
        : {
            type: HookType.ROUTING,
            owner: owner,
            domains: destinationChains
              .filter((c) => c !== origin)
              .filter((c) => c !== 'blast')
              .reduce(
                (acc, destination) => {
                  acc[destination] = defaultHook;
                  return acc;
                },
                {} as Record<ChainName, Address>,
              ),
          };
  }

  return {
    type: HookType.AGGREGATION,
    hooks: [
      routingHook,
      // Protocol Fee Hook
      {
        type: HookType.PROTOCOL_FEE,
        owner: owner,
        beneficiary: owner,

        // Use hardcoded, actual onchain fees, or fallback to fee calculation
        protocolFee:
          chainProtocolFee[origin] ??
          parseEther(getProtocolFee(origin)).toString(),
        maxProtocolFee: MAX_PROTOCOL_FEE,
      },
    ],
  };
}

function getRenzoIsmConfig(params: {
  origin: ChainName;
  chainsToDeploy: ChainName[];
  safes: ChainMap<Address>;
  validators: ChainMap<MultisigConfig>;
}): AggregationIsmConfig | RoutingIsmConfig {
  const { origin, safes, chainsToDeploy, validators } = params;

  if (origin === 'blast') {
    // If origin is blast, use routing ism without domains (restricts inbound from all chains).
    return {
      type: IsmType.ROUTING,
      owner: safes[origin],
      domains: {},
    };
  }

  return {
    type: IsmType.AGGREGATION,
    threshold: 2,
    modules: [
      {
        type: IsmType.ROUTING,
        owner: safes[origin],
        domains: buildAggregationIsmConfigs(origin, chainsToDeploy, validators),
      },
      {
        type: IsmType.FALLBACK_ROUTING,
        domains: {},
        owner: safes[origin],
      },
    ],
  };
}

const lockboxChain = 'ethereum';
// over the default 100k to account for xerc20 gas + ISM overhead over the default ISM https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/49f41d9759fd515bfd89e6e22e799c41b27b4119/typescript/sdk/src/router/GasRouterDeployer.ts#L14
const warpRouteOverheadGas = 200_000;
const ezEthProductionLockbox = '0xC8140dA31E6bCa19b287cC35531c2212763C2059';
const ezEthAddresses: Record<(typeof ezEthChainsToDeploy)[number], string> = {
  arbitrum: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  optimism: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  base: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  blast: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  bsc: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  mode: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  linea: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  ethereum: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  fraxtal: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  zircuit: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  taiko: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  sei: '0x6DCfbF4729890043DFd34A93A2694E5303BA2703', // redEth
  swell: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  unichain: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  berachain: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  worldchain: '0x2416092f143378750bb29b79eD961ab195CcEea5',
};

export const ezEthValidators: ChainMap<MultisigConfig> = {
  arbitrum: {
    threshold: 1,
    validators: [
      {
        address: '0x9bccfad3bd12ef0ee8ae839dd9ed7835bccadc9d',
        alias: 'Everclear',
      },
      { address: '0xc27032c6bbd48c20005f552af3aaa0dbf14260f3', alias: 'Renzo' },
    ],
  },
  optimism: {
    threshold: 1,
    validators: [
      {
        address: '0x6f4cb8e96db5d44422a4495faa73fffb9d30e9e2',
        alias: 'Everclear',
      },
      { address: '0xe2593d205f5e7f74a50fa900824501084e092ebd', alias: 'Renzo' },
    ],
  },
  base: {
    threshold: 1,
    validators: [
      { address: '0x25ba4ee5268cbfb8d69bac531aa10368778702bd', alias: 'Renzo' },
      {
        address: '0x9ec803b503e9c7d2611e231521ef3fde73f7a21c',
        alias: 'Everclear',
      },
    ],
  },
  blast: {
    threshold: 1,
    validators: [
      {
        address: '0x1652d8ba766821cf01aeea34306dfc1cab964a32',
        alias: 'Everclear',
      },
      { address: '0x54bb0036f777202371429e062fe6aee0d59442f9', alias: 'Renzo' },
    ],
  },
  bsc: {
    threshold: 1,
    validators: [
      { address: '0x3156db97a3b3e2dcc3d69fddfd3e12dc7c937b6d', alias: 'Renzo' },
      {
        address: '0x9a0326c43e4713ae2477f09e0f28ffedc24d8266',
        alias: 'Everclear',
      },
    ],
  },
  mode: {
    threshold: 1,
    validators: [
      {
        address: '0x456fbbe05484fc9f2f38ea09648424f54d6872be',
        alias: 'Everclear',
      },
      { address: '0x7e29608c6e5792bbf9128599ca309be0728af7b4', alias: 'Renzo' },
    ],
  },
  linea: {
    threshold: 1,
    validators: [
      {
        address: '0x06a5a2a429560034d38bf62ca6d470942535947e',
        alias: 'Everclear',
      },
      { address: '0xcb3e44edd2229860bdbaa58ba2c3817d111bee9a', alias: 'Renzo' },
    ],
  },
  ethereum: {
    threshold: 1,
    validators: [
      {
        address: '0x1fd889337f60986aa57166bc5ac121efd13e4fdd',
        alias: 'Everclear',
      },
      { address: '0xc7f7b94a6baf2fffa54dfe1dde6e5fcbb749e04f', alias: 'Renzo' },
    ],
  },
  fraxtal: {
    threshold: 1,
    validators: [
      {
        address: '0x25b3a88f7cfd3c9f7d7e32b295673a16a6ddbd91',
        alias: 'Luganodes',
      },
      { address: '0xe986f457965227a05dcf984c8d0c29e01253c44d', alias: 'Renzo' },
    ],
  },
  zircuit: {
    threshold: 1,
    validators: [
      { address: '0x1da9176c2ce5cc7115340496fa7d1800a98911ce', alias: 'Renzo' },
      {
        address: '0x7ac6584c068eb2a72d4db82a7b7cd5ab34044061',
        alias: 'Luganodes',
      },
    ],
  },
  taiko: {
    threshold: 1,
    validators: [
      {
        address: '0x2f007c82672f2bb97227d4e3f80ac481bfb40a2a',
        alias: 'Luganodes',
      },
      { address: '0xd4F6000d8e1108bd4998215d51d5dF559BdB43a1', alias: 'Renzo' },
    ],
  },
  sei: {
    threshold: 1,
    validators: [
      {
        address: '0x7a0f4a8672f603e0c12468551db03f3956d10910',
        alias: 'Luganodes',
      },
      { address: '0x952df7f0cb8611573a53dd7cbf29768871d9f8b0', alias: 'Renzo' },
    ],
  },
  swell: {
    threshold: 1,
    validators: [
      {
        address: '0x9eadf9217be22d9878e0e464727a2176d5c69ff8',
        alias: 'Luganodes',
      },
      { address: '0xb6b9b4bd4eb6eb3aef5e9826e7f8b8455947f67c', alias: 'Renzo' },
    ],
  },
  unichain: {
    threshold: 1,
    validators: [
      {
        address: '0xa9d517776fe8beba7d67c21cac1e805bd609c08e',
        alias: 'Luganodes',
      },
      { address: '0xfe318024ca6197f2157905209149067a11e6982c', alias: 'Renzo' },
    ],
  },
  berachain: {
    threshold: 1,
    validators: [
      {
        address: '0xa7341aa60faad0ce728aa9aeb67bb880f55e4392',
        alias: 'Luganodes',
      },
      { address: '0xae09cb3febc4cad59ef5a56c1df741df4eb1f4b6', alias: 'Renzo' },
    ],
  },
  worldchain: {
    threshold: 1,
    validators: [
      {
        address: '0x15c6aaf2d982651ea5ae5f080d0ddfe7d6545f19',
        alias: 'Luganodes',
      },
      { address: '0x650a1bcb489BE2079d82602c10837780ef6dADA8', alias: 'Renzo' },
    ],
  },
};

export const ezEthSafes: Record<(typeof ezEthChainsToDeploy)[number], string> =
  {
    arbitrum: '0x0e60fd361fF5b90088e1782e6b21A7D177d462C5',
    optimism: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
    base: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
    blast: '0xda7dBF0DB81882372B598a715F86eD5254A01b0a',
    bsc: '0x0e60fd361fF5b90088e1782e6b21A7D177d462C5',
    mode: '0x7791eeA3484Ba4E5860B7a2293840767619c2B58',
    linea: '0xb7092685571B49786F1248c6205B5ac3A691c65E',
    ethereum: '0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A',
    fraxtal: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
    zircuit: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
    taiko: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
    sei: '0x0e60fd361fF5b90088e1782e6b21A7D177d462C5',
    swell: '0x435E8c9652Da151292F3981bbf663EBEB6668501',
    unichain: '0x70aF964829DA7F3f51973EE806AEeAB9225F2661',
    berachain: '0x865BA5789D82F2D4C5595a3968dad729A8C3daE6',
    worldchain: '0x7Be36310285cA4e809C296526745DA983c8F8e0f',
  };

const existingProxyAdmins: ChainMap<{ address: string; owner: string }> = {
  arbitrum: {
    address: '0xdcB558d5C0F9A35C53Fa343c77eD0d346576e2Cf',
    owner: ezEthSafes.arbitrum,
  },
  optimism: {
    address: '0xa50910ae66Df6A5F8e85dac032FD45BC2b7be6fF',
    owner: ezEthSafes.optimism,
  },
  base: {
    address: '0xec1DdF05ff85D2B22B7d27E5b5E0B82961B7D889',
    owner: ezEthSafes.base,
  },
  blast: {
    address: '0xA26F8cE2E21A503bf9e18c213965d7BC14997F48',
    owner: ezEthSafes.blast,
  },
  bsc: {
    address: '0x486b39378f99f073A3043C6Aabe8666876A8F3C5',
    owner: ezEthSafes.bsc,
  },
  mode: {
    address: '0x2F78F22a1D7491500C9ED9352b8239fbAbcDd84E',
    owner: ezEthSafes.mode,
  },
  fraxtal: {
    address: '0x8bB69721B4E9b9df08bEdaeaA193008C7317Db59',
    owner: ezEthSafes.fraxtal,
  },
  linea: {
    address: '0x2F78F22a1D7491500C9ED9352b8239fbAbcDd84E',
    owner: ezEthSafes.linea,
  },
  ethereum: {
    address: '0x2F78F22a1D7491500C9ED9352b8239fbAbcDd84E',
    owner: ezEthSafes.ethereum,
  },
  zircuit: {
    address: '0xec1DdF05ff85D2B22B7d27E5b5E0B82961B7D889',
    owner: ezEthSafes.zircuit,
  },
  sei: {
    address: '0x33219fEF24C198d979F05d692a17507E41a0A73e',
    owner: ezEthSafes.sei,
  },
  taiko: {
    address: '0xA3666f8a327AADB666F1906A38B17937e5F11f92',
    owner: ezEthSafes.taiko,
  },
};

export function getRenzoWarpConfigGenerator(params: {
  chainsToDeploy: string[];
  validators: ChainMap<MultisigConfig>;
  safes: Record<string, string>;
  xERC20Addresses: Record<string, string>;
  xERC20Lockbox: string;
  tokenPrices: ChainMap<string>;
  existingProxyAdmins?: ChainMap<{ address: string; owner: string }>;
  useLegacyRoutingHook: boolean;
}) {
  const {
    chainsToDeploy,
    validators,
    safes,
    xERC20Addresses,
    xERC20Lockbox,
    tokenPrices,
    existingProxyAdmins,
    useLegacyRoutingHook,
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
            const ret: [string, HypTokenRouterConfig] = [
              chain,
              {
                isNft: false,
                type:
                  chain === lockboxChain
                    ? TokenType.XERC20Lockbox
                    : TokenType.XERC20,
                token:
                  chain === lockboxChain
                    ? xERC20Lockbox
                    : xERC20Addresses[chain],
                owner: safes[chain],
                gas: warpRouteOverheadGas,
                mailbox,
                interchainSecurityModule: getRenzoIsmConfig({
                  origin: chain,
                  safes,
                  chainsToDeploy,
                  validators,
                }),
                hook: getRenzoHook({
                  defaultHook,
                  origin: chain,
                  destinationChains: ezEthChainsToDeploy,
                  owner: safes[chain],
                  useLegacyRoutingHook,
                }),
                ...(existingProxyAdmins?.[chain]
                  ? { proxyAdmin: existingProxyAdmins?.[chain] }
                  : {}),
              },
            ];

            return ret;
          },
        ),
      ),
    );

    return tokenConfig;
  };
}

export const getRenzoEZETHWarpConfig = getRenzoWarpConfigGenerator({
  chainsToDeploy: ezEthChainsToDeploy,
  validators: ezEthValidators,
  safes: ezEthSafes,
  xERC20Addresses: ezEthAddresses,
  xERC20Lockbox: ezEthProductionLockbox,
  tokenPrices: renzoTokenPrices,
  existingProxyAdmins: existingProxyAdmins,
  useLegacyRoutingHook: false,
});

export const getEZETHGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(ezEthSafes);
