import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { regularIcas } from '../../governance/ica/regular.js';
import { regularSafes } from '../../governance/safe/regular.js';

export const getAncient8EthereumUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ismConfig = buildAggregationIsmConfigs(
    'ethereum',
    ['ancient8'],
    defaultMultisigConfigs,
  ).ancient8;

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: ismConfig,
    // This hook was recovered from running the deploy script
    // for the hook module. The hook configuration is the Ethereum
    // default hook for the Ancient8 remote (no routing).
    hook: '0x19b2cF952b70b217c90FC408714Fbc1acD29A6A8',
    // The ProxyAdmin is owned by the legacy Safe, not the standard AW owner.
    // Set ownerOverrides.proxyAdmin (not just proxyAdmin.owner) since config
    // expansion gives ownerOverrides.proxyAdmin precedence.
    ownerOverrides: {
      ...abacusWorksEnvOwnerConfig.ethereum.ownerOverrides,
      proxyAdmin: regularSafes.ethereum,
    },
    proxyAdmin: {
      owner: regularSafes.ethereum,
    },
  };

  const ancient8: HypTokenRouterConfig = {
    ...routerConfig.ancient8,
    ...abacusWorksEnvOwnerConfig.ancient8,
    type: TokenType.synthetic,
    // Uses the default ISM
    interchainSecurityModule: ethers.constants.AddressZero,
    ownerOverrides: {
      ...abacusWorksEnvOwnerConfig.ancient8.ownerOverrides,
      proxyAdmin: regularIcas.ancient8,
    },
    proxyAdmin: {
      owner: regularIcas.ancient8,
    },
  };

  return {
    ethereum,
    ancient8,
  };
};
