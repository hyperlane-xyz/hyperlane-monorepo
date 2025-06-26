import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../src/config/warp.js';
import { ETHEREUM_DEPLOYER_ADDRESS } from '../../testnet4/owners.js';

import {
  messageTransmitterAddresses,
  tokenMessengerAddresses,
  usdcTokenAddresses,
} from './cctp.js';

const SERVICE_URL = 'https://testnet-offchain-lookup.services.hyperlane.xyz/';

export const getCCTPWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const chains = [
    'sepolia',
    'optimismsepolia',
    'arbitrumsepolia',
    'basesepolia',
  ] as const;

  const owner = ETHEREUM_DEPLOYER_ADDRESS;

  return Object.fromEntries(
    chains.map((chain) => {
      const config: HypTokenRouterConfig = {
        owner,
        mailbox: routerConfig[chain].mailbox,
        type: TokenType.collateralCctp,
        token: usdcTokenAddresses[chain],
        messageTransmitter: messageTransmitterAddresses[chain],
        tokenMessenger: tokenMessengerAddresses[chain],
        urls: [`${SERVICE_URL}/cctp/getCctpAttestation`],
      };
      return [chain, config];
    }),
  );
};
