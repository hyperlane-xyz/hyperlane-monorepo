import { ethers } from 'ethers';

import {
  ChainMap,
  ERC20RouterConfig,
  HyperlaneCore,
  HyperlaneIsmFactory,
  MultiProvider,
  RouterConfig,
  TokenConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { Modules, getAddresses } from '../scripts/agent-utils';
import {
  EnvironmentConfig,
  deployEnvToSdkEnv,
} from '../src/config/environment';
import { tokens } from '../src/config/warp';

import { DEPLOYER } from './environments/mainnet3/owners';

export async function getWarpConfig(
  multiProvider: MultiProvider,
  envConfig: EnvironmentConfig,
): Promise<ChainMap<TokenConfig & RouterConfig>> {
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[envConfig.environment],
    multiProvider,
  );
  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    getAddresses(envConfig.environment, Modules.PROXY_FACTORY),
    multiProvider,
  );

  const owner = DEPLOYER;

  // "Manually" deploying an ISM because the warp deployer doesn't support
  // ISM objects at the moment, and the deploy involves strictly recoverable ISMs.
  const ism = await ismFactory.deploy({
    destination: 'ethereum',
    config: buildAggregationIsmConfigs(
      'ethereum',
      ['ancient8'],
      defaultMultisigConfigs,
    ).ancient8,
  });

  const routerConfig = core.getRouterConfig(envConfig.owners);

  const ethereum: TokenConfig & RouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: ism.address,
    // This hook was recovered from running the deploy script
    // for the hook module. The hook configuration is the Ethereum
    // default hook for the Ancient8 remote (no routing).
    hook: '0x19b2cF952b70b217c90FC408714Fbc1acD29A6A8',
    owner,
  };

  // @ts-ignore
  const ancient8: TokenConfig & RouterConfig = {
    ...routerConfig.ancient8,
    // name: 'string',
    // symbol: 'string',
    // totalSupply: '0',
    type: TokenType.synthetic,
    // Uses the default ISM
    interchainSecurityModule: ethers.constants.AddressZero,
    owner,
  };

  return {
    ethereum,
    ancient8,
  };
}
