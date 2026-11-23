import { ethers } from 'ethers';
import { z } from 'zod';

import {
  MailboxClient__factory,
  TokenBridgeOft__factory,
} from '@hyperlane-xyz/core';
import {
  EvmMovableCollateralAdapter,
  type ChainMap,
  type Token,
} from '@hyperlane-xyz/sdk';
import type { MultiProviderAdapter } from '@hyperlane-xyz/sdk/providers/MultiProviderAdapter';
import { addressToBytes32, assert, eqAddress } from '@hyperlane-xyz/utils';

import {
  ExecutionType,
  TokenBridgeStatusAdapterType,
  type StrategyConfig,
  type TokenBridgeStatusAdapterConfig,
} from '../../config/types.js';

const OFT_ENDPOINT_INTERFACE = new ethers.utils.Interface([
  'function endpoint() view returns (address)',
  'function peers(uint32) view returns (bytes32)',
]);
const ENDPOINT_INTERFACE = new ethers.utils.Interface([
  'function eid() view returns (uint32)',
]);

async function endpointId(
  oft: string,
  provider: ethers.providers.Provider,
): Promise<number> {
  const endpointResult = await provider.call({
    to: oft,
    data: OFT_ENDPOINT_INTERFACE.encodeFunctionData('endpoint'),
  });
  const endpoint = z
    .string()
    .parse(
      OFT_ENDPOINT_INTERFACE.decodeFunctionResult(
        'endpoint',
        endpointResult,
      )[0],
    );
  const eidResult = await provider.call({
    to: endpoint,
    data: ENDPOINT_INTERFACE.encodeFunctionData('eid'),
  });
  return z
    .number()
    .int()
    .positive()
    .parse(ENDPOINT_INTERFACE.decodeFunctionResult('eid', eidResult)[0]);
}

/** Validate the actual per-pair routes after defaults and overrides are merged. */
export async function validateOftRoutes(
  strategies: StrategyConfig[],
  tokens: ChainMap<Token>,
  multiProvider: MultiProviderAdapter,
): Promise<void> {
  for (const strategy of strategies) {
    for (const [origin, base] of Object.entries(strategy.chains)) {
      for (const destination of Object.keys(strategy.chains)) {
        if (origin === destination) continue;
        const effective = { ...base, ...base.override?.[destination] };
        if (
          effective.enabled === false ||
          (effective.executionType ?? ExecutionType.MovableCollateral) !==
            ExecutionType.MovableCollateral
        )
          continue;
        await validateSettlementRoute(
          origin,
          destination,
          effective,
          tokens,
          multiProvider,
        );
      }
    }
  }
}

/** Prove that the selected family can be tracked before an approval or source send. */
export async function validateSettlementRoute(
  origin: string,
  destination: string,
  effective: {
    bridge?: string;
    statusAdapter?: TokenBridgeStatusAdapterConfig;
  },
  tokens: ChainMap<Token>,
  multiProvider: MultiProviderAdapter,
): Promise<void> {
  const status = effective.statusAdapter;
  const pair = `${origin} -> ${destination}`;
  assert(effective.bridge, `Missing settlement bridge for ${pair}`);
  if (status?.kind !== TokenBridgeStatusAdapterType.LayerZeroScan) {
    // A failed oft() lookup is never proof that a bridge dispatches Hyperlane messages.
    // Require positive Hyperlane identity instead; OFT adapters lack these getters.
    const provider = multiProvider.getEthersV5Provider(origin);
    assert(tokens[origin], `Missing origin token for ${pair}`);
    const bridge = MailboxClient__factory.connect(effective.bridge, provider);
    const router = MailboxClient__factory.connect(
      tokens[origin].addressOrDenom,
      provider,
    );
    try {
      const [mailbox, domain, expectedMailbox] = await Promise.all([
        bridge.mailbox(),
        bridge.localDomain(),
        router.mailbox(),
      ]);
      assert(
        domain === multiProvider.getDomainId(origin) &&
          mailbox !== ethers.constants.AddressZero &&
          eqAddress(mailbox, expectedMailbox),
        `Hyperlane bridge identity mismatch for ${pair}`,
      );
    } catch (error) {
      throw new Error(
        `Hyperlane settlement preflight failed for ${pair} via ${effective.bridge}; OFT bridges require lz_scan`,
        { cause: error },
      );
    }
    return;
  }
  assert(
    tokens[origin] && tokens[destination],
    `Missing OFT route tokens for ${pair}`,
  );
  assert(effective.bridge, `Missing OFT bridge for ${pair}`);
  const monitoredRecipient = tokens[destination].addressOrDenom;
  const expectedRecipient = status.destinationRecipient ?? monitoredRecipient;
  assert(
    eqAddress(expectedRecipient, monitoredRecipient),
    `OFT recipient does not match monitored collateral for ${pair}`,
  );
  const originAdapter = tokens[origin].getHypAdapter(multiProvider);
  assert(
    originAdapter instanceof EvmMovableCollateralAdapter,
    `OFT origin is not movable collateral for ${pair}`,
  );
  const allowedDestination = await originAdapter.getAllowedDestination(
    multiProvider.getDomainId(destination),
  );
  assert(
    eqAddress(expectedRecipient, allowedDestination),
    `OFT recipient does not match allowed destination for ${pair}`,
  );
  const provider = multiProvider.getEthersV5Provider(origin);
  const destinationProvider = multiProvider.getEthersV5Provider(destination);
  const bridge = TokenBridgeOft__factory.connect(effective.bridge, provider);
  const [
    sourceOft,
    destinationEid,
    sourceEid,
    actualDestinationEid,
    peerResult,
  ] = await Promise.all([
    bridge.oft(),
    bridge.hyperlaneDomainToLzEid(multiProvider.getDomainId(destination)),
    endpointId(status.sourceOft, provider),
    endpointId(status.destinationOft, destinationProvider),
    provider.call({
      to: status.sourceOft,
      data: OFT_ENDPOINT_INTERFACE.encodeFunctionData('peers', [
        status.destinationEid,
      ]),
    }),
  ]);
  const peer = z
    .string()
    .parse(OFT_ENDPOINT_INTERFACE.decodeFunctionResult('peers', peerResult)[0]);
  assert(
    eqAddress(sourceOft, status.sourceOft),
    `OFT source contract mismatch for ${pair}`,
  );
  assert(
    sourceEid === status.sourceEid,
    `OFT source endpoint mismatch for ${pair}`,
  );
  assert(
    destinationEid === status.destinationEid &&
      actualDestinationEid === status.destinationEid,
    `OFT destination endpoint mismatch for ${pair}`,
  );
  assert(
    peer.toLowerCase() ===
      addressToBytes32(status.destinationOft).toLowerCase(),
    `OFT destination peer mismatch for ${pair}`,
  );
}
