import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

export const getTRUMPWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const name = 'OFFICIAL TRUMP';
  const symbol = 'TRUMP';
  const syntheticToken = {
    name,
    symbol,
    decimals: 18,
  };
  const tokenConfig: ChainMap<HypTokenRouterConfig> = {
    solanamainnet: {
      ...routerConfig.solanamainnet,
      type: TokenType.collateral,
      name,
      symbol,
      token: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
      owner: DEPLOYER,
      foreignDeployment: '21tAY4poz2VXvghqdSQpn9j7gYravQmGpuQi8pHPx9DS',
      gas: 64000,
    },
    base: {
      ...routerConfig.base,
      ...syntheticToken,
      type: TokenType.synthetic,
      owner: abacusWorksEnvOwnerConfig.base.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.base.owner,
        address: '0xBaE44c2D667C73e2144d938d6cC87901A6fd1c00',
      },
    },
    arbitrum: {
      ...routerConfig.arbitrum,
      ...syntheticToken,
      type: TokenType.synthetic,
      owner: abacusWorksEnvOwnerConfig.arbitrum.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.arbitrum.owner,
        address: '0x2350389Ea8649Da5dD4Fdd09c414dD8463C2695c',
      },
    },
    avalanche: {
      ...routerConfig.avalanche,
      ...syntheticToken,
      type: TokenType.synthetic,
      owner: abacusWorksEnvOwnerConfig.avalanche.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.avalanche.owner,
        address: '0x86a2E32BB42584127a24079a4f9113EeFE80db90',
      },
    },
    flowmainnet: {
      ...routerConfig.flowmainnet,
      ...syntheticToken,
      type: TokenType.synthetic,
      owner: abacusWorksEnvOwnerConfig.flowmainnet.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.flowmainnet.owner,
        address: '0xB504EA900302C7Faf24Cc4F155006d6c0357Dc35',
      },
    },
    form: {
      ...routerConfig.form,
      ...syntheticToken,
      type: TokenType.synthetic,
      owner: abacusWorksEnvOwnerConfig.form.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.form.owner,
        address: '0x5b3EeADcc0E2d4284eA6816e2E503c24d30a9E54',
      },
    },
    worldchain: {
      ...routerConfig.worldchain,
      ...syntheticToken,
      type: TokenType.synthetic,
      owner: abacusWorksEnvOwnerConfig.worldchain.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.worldchain.owner,
        address: '0x97e4682dBC4Bfd432F1563a7fa9aC218Bc48c861',
      },
    },
    optimism: {
      ...routerConfig.optimism,
      ...syntheticToken,
      type: TokenType.synthetic,
      owner: abacusWorksEnvOwnerConfig.optimism.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.optimism.owner,
        address: '0x6Fa52E2Fc86B200e7b80394e226929C1f9Ff2950',
      },
    },
  };
  return tokenConfig;
};
