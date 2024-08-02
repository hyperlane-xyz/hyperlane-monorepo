import { ethers } from 'ethers';

import {
  ChainMap,
  HyperlaneIsmFactory,
  MultiProvider,
  TokenRouterConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { Modules, getAddresses } from '../scripts/agent-utils.js';
import { getHyperlaneCore } from '../scripts/core-utils.js';
import { EnvironmentConfig } from '../src/config/environment.js';
import { tokens } from '../src/config/warp.js';

import { DEPLOYER } from './environments/mainnet3/owners.js';

export async function getWarpConfig(
  multiProvider: MultiProvider,
  envConfig: EnvironmentConfig,
): Promise<ChainMap<TokenRouterConfig>> {
  const { core } = await getHyperlaneCore(envConfig.environment, multiProvider);

  const deployer = '0xfaD1C94469700833717Fa8a3017278BC1cA8031C';
  const safe = '0xA9B8afF7d18E15b1613C28f110fD0dEeE06Da509';
  // owned by 0xfad
  // const alfajoresIca = '0xb8c49ef544c43d3842d693a61fc99911f22b1453';
  // owned by multisig
  const alfajoresIca = '0x60063ce2466dc3c55f379328c0d1cef3d41f4ed8';

  const routerConfig = core.getRouterConfig(envConfig.owners);

  const sepolia: TokenRouterConfig = {
    ...routerConfig.sepolia,
    type: TokenType.native,
    owner: safe, // owner,
  };

  const alfajores: TokenRouterConfig = {
    ...routerConfig.alfajores,
    type: TokenType.synthetic,
    name: 'Test ETH',
    symbol: 'tETH',
    owner: deployer, //alfajoresIca, // deployer, // alfajoresIca,
  };

  // const ethereum: TokenRouterConfig = {
  //   ...routerConfig.ethereum,
  //   type: TokenType.collateral,
  //   token: tokens.ethereum.USDC,
  //   interchainSecurityModule: ism.address,
  //   // This hook was recovered from running the deploy script
  //   // for the hook module. The hook configuration is the Ethereum
  //   // default hook for the Ancient8 remote (no routing).
  //   hook: '0x19b2cF952b70b217c90FC408714Fbc1acD29A6A8',
  //   owner,
  // };

  // // @ts-ignore - The types as they stand require a synthetic to specify
  // // TokenMetadata, but in practice these are actually inferred from a
  // // collateral config. To avoid needing to specify the TokenMetadata, just
  // // ts-ignore for synthetic tokens.
  // const ancient8: TokenRouterConfig = {
  //   ...routerConfig.ancient8,
  //   type: TokenType.synthetic,
  //   // Uses the default ISM
  //   interchainSecurityModule: ethers.constants.AddressZero,
  //   owner,
  // };

  return {
    sepolia,
    alfajores,
  };
}
