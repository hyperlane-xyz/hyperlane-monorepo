import {
  ChainMap,
  OwnableConfig,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  getNonAbacusWorksOwnerConfig,
} from '../../../../../src/config/warp.js';

// Eclipse Fi team
const arbitrumOwner = '0xfF07222cb0AC905304d6586Aabf13f497C07F0C8';
// Eclipse Fi team
const neutronOwner = 'TODO';

export const getArbitrumNeutronEclipWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const neutronRouter =
    '6b04c49fcfd98bc4ea9c05cd5790462a39537c00028333474aebe6ddf20b73a3';

  // @ts-ignore - foreignDeployment configs dont conform to the TokenRouterConfig
  // TODO come back here
  const neutron: TokenRouterConfig = {
    ...routerConfig.neutron,
    ...getNonAbacusWorksOwnerConfig(neutronOwner),
    foreignDeployment: neutronRouter,
  };

  const arbitrum: TokenRouterConfig = {
    ...routerConfig.arbitrum,
    ...getNonAbacusWorksOwnerConfig(arbitrumOwner),
    type: TokenType.synthetic,
    name: 'Eclipse Fi',
    symbol: 'ECLIP',
    decimals: 6,
    totalSupply: 0,
    gas: 600_000,
    interchainSecurityModule: '0x676151bFB8D29690a359F99AE764860595504689', // This has diverged from the default ism on neutron, we cannot change as it is owned by the Eclip team
  };

  return {
    neutron,
    arbitrum,
  };
};
