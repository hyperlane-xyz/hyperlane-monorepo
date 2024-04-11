import {
  HyperlaneCore,
  HyperlaneIsmFactory,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { Modules, getAddresses } from '../../../scripts/agent-utils';
import { deployEnvToSdkEnv } from '../../../src/config/environment';

import { environment } from './chains';

async function getWarpConfig(multiProvider: MultiProvider) {
  const core = HyperlaneCore.fromEnvironment(
    deployEnvToSdkEnv[environment],
    multiProvider,
  );
  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    getAddresses(environment, Modules.PROXY_FACTORY),
    multiProvider,
  );

  const ism = await ismFactory.deploy({
    destination: 'ethereum',
    config: buildAggregationIsmConfigs(
      'ethereum',
      ['ancient8'],
      defaultMultisigConfigs,
    ).ancient8,
  });

  const routerConfig = core.getRouterConfig(envConfig.owners);

  const ethereum = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    // Really, this should be an object config from something like:
    //   buildAggregationIsmConfigs(
    //     'ethereum',
    //     ['ancient8'],
    //     defaultMultisigConfigs,
    //   ).ancient8
    // However ISM objects are no longer able to be passed directly to the warp route
    // deployer. As a temporary workaround, I'm using an ISM address from a previous
    // ethereum <> ancient8 warp route deployment:
    //   $ cast call 0x9f5cF636b4F2DC6D83c9d21c8911876C235DbC9f 'interchainSecurityModule()(address)' --rpc-url https://rpc.ankr.com/eth
    //   0xD17B4100cC66A2F1B9a452007ff26365aaeB7EC3
    interchainSecurityModule: ism.address,
    // This hook was recovered from running the deploy script
    // for the hook module. The hook configuration is the Ethereum
    // default hook for the Ancient8 remote (no routing).
    hook: '0x19b2cF952b70b217c90FC408714Fbc1acD29A6A8',
    owner: DEPLOYER,
  };

  const ancient8 = {
    ...routerConfig.ancient8,
    type: TokenType.synthetic,
    // Uses the default ISM
    interchainSecurityModule: ethers.constants.AddressZero,
    owner: DEPLOYER,
  };

  config = {
    ethereum,
    ancient8,
  };
}
