import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

// Eclipse Fi team
const arbitrumOwner = '0xfF07222cb0AC905304d6586Aabf13f497C07F0C8';
const neutronOwner =
  'neutron1aud8lty0wwmyc86ugkzqrusnrku0ckm0ym62v4ve0jjjyepjjg6spssrwj';

export const getArbitrumNeutronEclipWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const neutronRouter =
    '6b04c49fcfd98bc4ea9c05cd5790462a39537c00028333474aebe6ddf20b73a3';

  const neutron: HypTokenRouterConfig = {
    ...routerConfig.neutron,
    ...getOwnerConfigForAddress(neutronOwner),
    type: TokenType.collateral,
    token: 'factory/neutron10sr06r3qkhn7xzpw3339wuj77hu06mzna6uht0/eclip',
    foreignDeployment: neutronRouter,
  };

  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    ...getOwnerConfigForAddress(arbitrumOwner),
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
