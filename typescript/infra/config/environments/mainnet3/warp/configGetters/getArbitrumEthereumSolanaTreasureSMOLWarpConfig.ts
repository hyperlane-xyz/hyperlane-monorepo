import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

// Treasure Squads
const solanaOwner = '5KHDfxogWAiiDc3FWQJjT2RC6m38dte9JPfnYjwfbJ5V';

// Treasure team
const evmOwner = '0xD1D943c09b9C3355207ce8c85aB1c4558f6Cd851';

export async function getArbitrumEthereumSolanaTreasureSMOLWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const name = 'SMOL';
  const symbol = 'SMOL';
  const tokenConfig: ChainMap<HypTokenRouterConfig> = {
    solanamainnet: {
      ...routerConfig.solanamainnet,
      type: TokenType.synthetic,
      name,
      symbol,
      owner: solanaOwner,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      foreignDeployment: '7Z7mZ4d31sfC3mcQYQXUNo6j9snByT2gs5eDkXYmZAyn',
    },
    treasure: {
      ...routerConfig.treasure,
      type: TokenType.synthetic,
      name,
      symbol,
      decimals: 18,
      owner: evmOwner,
    },
    ethereum: {
      ...routerConfig.ethereum,
      type: TokenType.synthetic,
      name,
      symbol,
      decimals: 18,
      owner: evmOwner,
    },
    // Not intended to be fully connected with Solana, but is connected with treasure and ethereum
    arbitrum: {
      ...routerConfig.arbitrum,
      type: TokenType.collateral,
      // SMOL
      token: '0x9e64d3b9e8ec387a9a58ced80b71ed815f8d82b5',
      name,
      symbol,
      decimals: 18,
      owner: evmOwner,
    },
  };
  return tokenConfig;
}
