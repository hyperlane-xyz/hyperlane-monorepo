import {
  ChainMap,
  ChainSubmissionStrategy,
  HypTokenRouterConfig,
  OwnableConfig,
  SubmitterMetadata,
  TokenType,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import {
  messageTransmitterAddresses,
  tokenMessengerAddresses,
  usdcTokenAddresses,
} from '../cctp.js';

const SERVICE_URL = 'https://offchain-lookup.services.hyperlane.xyz';

export const CCTP_CHAINS = [
  'ethereum',
  'avalanche',
  'optimism',
  'arbitrum',
  'base',
  'polygon',
  'unichain',
] as const;

export const getCCTPWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return Object.fromEntries(
    CCTP_CHAINS.map((chain) => {
      const owner = awIcas[chain] ?? awSafes[chain];
      assert(owner, `Owner not found for ${chain}`);
      const config: HypTokenRouterConfig = {
        owner,
        mailbox: routerConfig[chain].mailbox,
        type: TokenType.collateralCctp,
        token: usdcTokenAddresses[chain],
        messageTransmitter: messageTransmitterAddresses[chain],
        tokenMessenger: tokenMessengerAddresses[chain],
        urls: [`${SERVICE_URL}/cctp/getCctpAttestation`],
        contractVersion: '8.1.0',
      };
      return [chain, config];
    }),
  );
};

const safeChain = 'ethereum';
const icaOwner = awSafes[safeChain];
const safeSubmitter: SubmitterMetadata = {
  type: TxSubmitterType.GNOSIS_SAFE,
  chain: safeChain,
  safeAddress: icaOwner,
};

const icaChains = Object.keys(awIcas);

export const getCCTPStrategyConfig = (): ChainSubmissionStrategy => {
  const submitterMetadata = CCTP_CHAINS.map((chain): SubmitterMetadata => {
    if (!icaChains.includes(chain)) {
      return {
        type: TxSubmitterType.GNOSIS_SAFE,
        chain,
        safeAddress: awSafes[chain],
      };
    }

    return {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: safeChain,
      owner: icaOwner,
      destinationChain: chain,
      internalSubmitter: safeSubmitter,
    };
  });

  return Object.fromEntries(
    CCTP_CHAINS.map((chain, index) => [
      chain,
      { submitter: submitterMetadata[index] },
    ]),
  );
};
