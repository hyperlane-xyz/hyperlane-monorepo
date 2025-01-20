import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

export const getTRUMPWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const tokenConfig: ChainMap<HypTokenRouterConfig> = {
    solanamainnet: {
      ...routerConfig.solanamainnet,
      type: TokenType.collateral,
      name: 'OFFICIAL TRUMP',
      symbol: 'TRUMP',
      decimals: 6,
      totalSupply: 0,
      token: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
      owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      foreignDeployment: '21tAY4poz2VXvghqdSQpn9j7gYravQmGpuQi8pHPx9DS',
    },
    base: {
      ...routerConfig.base,
      type: TokenType.synthetic,
      name: 'OFFICIAL TRUMP',
      symbol: 'TRUMP',
      decimals: 18,
      totalSupply: 0,
      owner: abacusWorksEnvOwnerConfig.base.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.base.owner,
        address: '0xBaE44c2D667C73e2144d938d6cC87901A6fd1c00',
      },
    },
    arbitrum: {
      ...routerConfig.arbitrum,
      type: TokenType.synthetic,
      name: 'OFFICIAL TRUMP',
      symbol: 'TRUMP',
      decimals: 18,
      totalSupply: 0,
      owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      proxyAdmin: {
        owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
        address: '0x2350389Ea8649Da5dD4Fdd09c414dD8463C2695c',
      },
    },
    avalanche: {
      ...routerConfig.avalanche,
      type: TokenType.synthetic,
      name: 'OFFICIAL TRUMP',
      symbol: 'TRUMP',
      decimals: 18,
      totalSupply: 0,
      owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      proxyAdmin: {
        owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
        address: '0x86a2E32BB42584127a24079a4f9113EeFE80db90',
      },
    },
    flowmainnet: {
      ...routerConfig.flowmainnet,
      type: TokenType.synthetic,
      name: 'OFFICIAL TRUMP',
      symbol: 'TRUMP',
      decimals: 18,
      totalSupply: 0,
      owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      proxyAdmin: {
        owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
        address: '0xB504EA900302C7Faf24Cc4F155006d6c0357Dc35',
      },
    },
    form: {
      ...routerConfig.form,
      type: TokenType.synthetic,
      name: 'OFFICIAL TRUMP',
      symbol: 'TRUMP',
      decimals: 18,
      totalSupply: 0,
      owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      proxyAdmin: {
        owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
        address: '0x5b3EeADcc0E2d4284eA6816e2E503c24d30a9E54',
      },
    },
    worldchain: {
      ...routerConfig.worldchain,
      type: TokenType.synthetic,
      name: 'OFFICIAL TRUMP',
      symbol: 'TRUMP',
      decimals: 18,
      totalSupply: 0,
      owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      proxyAdmin: {
        owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
        address: '0x97e4682dBC4Bfd432F1563a7fa9aC218Bc48c861',
      },
    },
  };
  return tokenConfig;
};
