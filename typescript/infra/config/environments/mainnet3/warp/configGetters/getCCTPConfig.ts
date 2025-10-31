import {
  ChainMap,
  ChainName,
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
  messageTransmitterV1Addresses,
  messageTransmitterV2Addresses,
  tokenMessengerV1Addresses,
  tokenMessengerV2Addresses,
  usdcTokenAddresses,
} from '../cctp.js';

const SERVICE_URL = 'https://offchain-lookup.services.hyperlane.xyz';

export const CCTP_CHAINS = Object.keys(tokenMessengerV2Addresses);

// TODO: remove this once the route has been updated to be owned by non-legacy ownership
const owners: Record<ChainName, string> = {
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
  version: 'V1' | 'V2' = 'V1',
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const messengerAddresses =
    version === 'V1' ? tokenMessengerV1Addresses : tokenMessengerV2Addresses;
  const transmitterAddresses =
    version === 'V1'
      ? messageTransmitterV1Addresses
      : messageTransmitterV2Addresses;
  const chains = Object.keys(messengerAddresses) as Array<
    keyof typeof messengerAddresses
  >;

  return Object.fromEntries(
    chains.map((chain) => {
      // TODO: restore after route has been updated
      // const owner = awIcasLegacy[chain] ?? awSafes[chain];

      const owner = owners[chain];

      assert(owner, `Owner not found for ${chain}`);
      const config: HypTokenRouterConfig = {
        owner,
        mailbox: routerConfig[chain].mailbox,
        type: TokenType.collateralCctp,
        token: usdcTokenAddresses[chain],
        messageTransmitter: transmitterAddresses[chain],
        tokenMessenger: messengerAddresses[chain],
        cctpVersion: version,
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

export const getCCTPStrategyConfig = (
  version: 'V1' | 'V2' = 'V1',
): ChainSubmissionStrategy => {
  const chains =
    version === 'V1'
      ? Object.keys(tokenMessengerV1Addresses)
      : Object.keys(tokenMessengerV2Addresses);
  const submitterMetadata = chains.map((chain): SubmitterMetadata => {
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
    chains.map((chain, index) => [
      chain,
      { submitter: submitterMetadata[index] },
    ]),
  );
};
