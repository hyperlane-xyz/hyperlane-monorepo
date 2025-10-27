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
  'plasma',
  'ink',
  'monad',
  'xlayer',
];
export const MAX_PROTOCOL_FEE = parseEther('100').toString(); // Changing this will redeploy the PROTOCOL_FEE hook

// Used to stabilize the protocolFee of ProtocolHook upon deployment such that we don't get diffs every time tokenPrices.json is updated
export const renzoTokenPrices: ChainMap<string> = {
  arbitrum: '3157.26', // ETH
  optimism: '3157.26', // ETH
  base: '3157.26', // ETH
  blast: '3157.26', // ETH
  bsc: '673.59', // BNB
  mode: '3157.26', // ETH
  linea: '3157.26', // ETH
  ethereum: '3157.26', // ETH
  fraxtal: '3168.75', // ETH
  zircuit: '3157.26', // ETH
  taiko: '3157.26', // ETH
  sei: '0.354988', // SEI
  swell: '3157.26', // ETH
  unichain: '2602.66', // ETH
  berachain: '10', // BERA
  worldchain: '1599.53', // ETH
  plasma: '0.90', // XPL
  ink: '3900', // ETH
  monad: '1', // MON placeholder price to avoid division by zero
  xlayer: '165', // OKB
};
export function getProtocolFee(chain: ChainName) {
  const price = renzoTokenPrices[chain];
  assert(price, `No price for chain ${chain}`);
  return (0.5 / Number(price)).toFixed(10).toString(); // ~$0.50 USD
}

// Fetched using: hyperlane warp check --warpRouteId EZETH/renzo-prod
// Set After deployment
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
  swell: '400000000000000',
  taiko: '400000000000000',
  unichain: '400000000000000',
  worldchain: '400000000000000',
  zircuit: '400000000000000',
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
  plasma: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  ink: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  monad: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  xlayer: '0x2416092f143378750bb29b79eD961ab195CcEea5',
};

export const ezEthValidators: ChainMap<MultisigConfig> = {
  arbitrum: {
    threshold: 1,
    validators: [
      {
        address: '0x57ddf0cd46f31ead8084069ce481507f4305c716',
        alias: 'Luganodes',
      },
      { address: '0xc27032c6bbd48c20005f552af3aaa0dbf14260f3', alias: 'Renzo' },
    ],
  },
  optimism: {
    threshold: 1,
    validators: [
      {
        address: '0xf9dfaa5c20ae1d84da4b2696b8dc80c919e48b12',
        alias: 'Luganodes',
      },
      { address: '0xe2593d205f5e7f74a50fa900824501084e092ebd', alias: 'Renzo' },
    ],
  },
  base: {
    threshold: 1,
    validators: [
      { address: '0x25ba4ee5268cbfb8d69bac531aa10368778702bd', alias: 'Renzo' },
      {
        address: '0xe957310e17730f29862e896709cce62d24e4b773',
        alias: 'Luganodes',
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
        address: '0xc67789546a7a983bf06453425231ab71c119153f',
        alias: 'Luganodes',
      },
    ],
  },
  mode: {
    threshold: 1,
    validators: [
      {
        address: '0x485a4f0009d9afbbf44521016f9b8cdd718e36ea',
        alias: 'Luganodes',
      },
      { address: '0x7e29608c6e5792bbf9128599ca309be0728af7b4', alias: 'Renzo' },
    ],
  },
  linea: {
    threshold: 1,
    validators: [
      {
        address: '0x0c760f4bcb508db9144b0579e26f5ff8d94daf4d',
        alias: 'Luganodes',
      },
      { address: '0xcb3e44edd2229860bdbaa58ba2c3817d111bee9a', alias: 'Renzo' },
    ],
  },
  ethereum: {
    threshold: 1,
    validators: [
      {
        address: '0xb683b742b378632a5f73a2a5a45801b3489bba44',
        alias: 'AVS: Luganodes',
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
  plasma: {
    threshold: 1,
    validators: [
      {
        address: '0x8516146068f7de5df6d65a54a631c968121df782',
        alias: 'Luganodes',
      },
      { address: '0x9A336232b3cc7399b500D09821AB14Caed008b7e', alias: 'Renzo' },
    ],
  },
  ink: {
    threshold: 1,
    validators: [
      {
        address: '0x4d3d970a2468c25d4b5c6af860d11b48223ca94b',
        alias: 'Luganodes',
      },
      { address: '0xe42562c4b4d72f28a11e6d02e5a641706f5815b3', alias: 'Renzo' },
    ],
  },
  monad: {
    threshold: 1,
    validators: [
      {
        address: '0x552d5a478d78a558eb473d844e4524de36d79cd9',
        alias: 'Luganodes',
      },
      { address: '0x59f6f0beb754f74a6d6b95d37f70066a474f2de7', alias: 'Renzo' },
    ],
  },
  xlayer: {
    threshold: 1,
    validators: [
      {
        address: '0xfcbd33064565403c9d8f038abf7d931140f3fd7d',
        alias: 'Luganodes',
      },
      { address: '0xecbe0864d34b215964c1abc21623aa8d0d75c723', alias: 'Renzo' },
    ],
  },
};

export const ezEthSafes: Record<(typeof ezEthChainsToDeploy)[number], string> =
  {
    arbitrum: '0xE5219Cf568D366ae4b96Efb04d826E6f2e72DaA0',
    optimism: '0x365DC37679F21B3Ef629158CA962f05Bac7f0236',
    base: '0xa87C18C9865e47f507e0C739d16C336aD764Fd95',
    blast: '0xa3A3488613A3e8C578e6AD466a5000Fb1c0897FB',
    bsc: '0x1bD739c88Cb90f88264488B914b6A1398840D426',
    mode: '0x0683c3cc018Fb76874FdCC8620d15c4E467e34CA',
    linea: '0xBAACd5f849024dcC80520BAA952f11aDFc59F9D0',
    ethereum: '0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A',
    fraxtal: '0x365DC37679F21B3Ef629158CA962f05Bac7f0236',
    zircuit: '0xc1036D6bBa2FE24c65823110B348Ee80D3386ACd',
    taiko: '0xE5219Cf568D366ae4b96Efb04d826E6f2e72DaA0',
    sei: '0x5247eCbF210f289C244813e89212bC3aEd75aAC1',
    swell: '0x672fb1C0F35DBD2074742765d23d18b80cbAAf22',
    unichain: '0xfC67503Ab4DF366C19858A13c3f8a68781c64DD5',
    berachain: '0xc1036D6bBa2FE24c65823110B348Ee80D3386ACd',
    worldchain: '0x672fb1C0F35DBD2074742765d23d18b80cbAAf22',
    plasma: '0x3eA4D0467C976e9877Adb96869Fdeb0551fd0930',
    ink: '0x42A4E564836AE98C2522368Be2faA6e96Ff7a07f',
    monad: '0xf2a0775ED23887F3C47Bf1f0D01cc580281dA2E4',
    xlayer: '0x8410927C286A38883BC23721e640F31D3E3E79F8',
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
}) {
  const {
    chainsToDeploy,
    validators,
    safes,
    xERC20Addresses,
    xERC20Lockbox,
    tokenPrices,
    existingProxyAdmins,
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
});

export const getEZETHGnosisSafeBuilderStrategyConfig =
  getGnosisSafeBuilderStrategyConfigGenerator(ezEthSafes);
