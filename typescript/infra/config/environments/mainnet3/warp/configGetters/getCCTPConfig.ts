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
import { awIcasLegacy } from '../../governance/ica/_awLegacy.js';
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

// TODO: remove this once the route has been updated to be owned by non-legacy ownership
const owners: Record<(typeof CCTP_CHAINS)[number], string> = {
  arbitrum: '0xaB547e6cde21a5cC3247b8F80e6CeC3a030FAD4A',
  avalanche: awIcasLegacy['avalanche'],
  base: '0xA6D9Aa3878423C266480B5a7cEe74917220a1ad2',
  ethereum: awSafes['ethereum'],
  optimism: '0x20E9C1776A9408923546b64D5ea8BfdF0B7319d6',
  polygon: awIcasLegacy['polygon'],
  unichain: awIcasLegacy['unichain'],
};

export const getCCTPWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
  _warpRouteId: string,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return Object.fromEntries(
    CCTP_CHAINS.map((chain) => {
      // TODO: restore after route has been updated
      // const owner = awIcasLegacy[chain] ?? awSafes[chain];

      const owner = owners[chain];

      assert(owner, `Owner not found for ${chain}`);
      const config: HypTokenRouterConfig = {
        owner,
        mailbox: routerConfig[chain].mailbox,
        type: TokenType.collateralCctp,
        token: usdcTokenAddresses[chain],
        messageTransmitter: messageTransmitterAddresses[chain],
        tokenMessenger: tokenMessengerAddresses[chain],
        cctpVersion: 'V1',
        urls: [`${SERVICE_URL}/cctp/getCctpAttestation`],
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

const icaChains = Object.keys(awIcasLegacy);

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
