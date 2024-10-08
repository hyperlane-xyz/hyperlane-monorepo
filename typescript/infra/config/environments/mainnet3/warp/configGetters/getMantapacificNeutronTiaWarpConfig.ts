import {
  ChainMap,
  IsmType,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

export const getMantapacificNeutronTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const neutronRouter =
    '0xc5fc6899019cb4a7649981d89eb7b1a0929d0a85b2d41802f3315129ad4b581a';

  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const neutron: TokenRouterConfig = {
    foreignDeployment: neutronRouter,
  };

  const mantapacific: TokenRouterConfig = {
    ...routerConfig.mantapacific,
    interchainSecurityModule: {
      type: IsmType.MESSAGE_ID_MULTISIG,
      validators: [
        '0xa9b8c1f4998f781f958c63cfcd1708d02f004ff0',
        '0xb65438a014fb05fbadcfe35bc6e25d372b6ba460',
        '0xc79503a3e3011535a9c60f6d21f76f59823a38bd',
        '0x42fa752defe92459370a052b6387a87f7de9b80c',
        '0x54b2cca5091b098a1a993dec03c4d1ee9af65999',
        '0x47aa126e05933b95c5eb90b26e6b668d84f4b25a',
      ],
      threshold: 4,
    },
    type: TokenType.synthetic,
    name: 'TIA',
    symbol: 'TIA',
    decimals: 6,
    totalSupply: 0,
    gas: 600_000,
  };

  return {
    mantapacific,
    neutron,
  };
};
