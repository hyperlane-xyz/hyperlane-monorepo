import { assert } from '@hyperlane-xyz/utils';

import type { MultiProviderAdapter } from '../providers/MultiProviderAdapter.js';
import { IToken } from '../token/IToken.js';
import { tokenIdentifiersEqual } from '../token/TokenMetadata.js';
import { ChainNameOrId } from '../types.js';

/**
 * Resolve the destination-side token for a warp transfer.
 *
 * - If `destinationToken` is provided, validates it matches one of the
 *   origin token's connections (and shares the destination chain).
 * - If omitted, the origin token must have exactly one connection to the
 *   destination chain — otherwise the route is ambiguous.
 *
 * Extracted from `WarpCore` so EVM and Sealevel quoted-transfer providers
 * can reuse the same resolution without depending on a `protected` method.
 */
export function resolveDestinationToken({
  multiProvider,
  originToken,
  destination,
  destinationToken,
}: {
  multiProvider: MultiProviderAdapter<{ mailbox?: string }>;
  originToken: IToken;
  destination: ChainNameOrId;
  destinationToken?: IToken;
}): IToken {
  const destinationName = multiProvider.getChainName(destination);
  const destinationCandidates = originToken
    .getConnections()
    .filter((connection) => connection.token.chainName === destinationName)
    .map((connection) => connection.token);

  assert(
    destinationCandidates.length > 0,
    `No connection found for ${destinationName}`,
  );

  if (destinationToken) {
    assert(
      destinationToken.chainName === destinationName,
      `Destination token chain mismatch for ${destinationName}`,
    );
    const matchedToken = destinationCandidates.find(
      (candidate) =>
        candidate.equals(destinationToken) ||
        tokenIdentifiersEqual(
          candidate.addressOrDenom,
          destinationToken.addressOrDenom,
        ),
    );
    assert(
      matchedToken,
      `Destination token ${destinationToken.addressOrDenom} is not connected from ${originToken.chainName} to ${destinationName}`,
    );
    return matchedToken;
  }

  assert(
    destinationCandidates.length === 1,
    `Ambiguous route to ${destinationName}; specify destination token`,
  );
  return destinationCandidates[0];
}
