import type { Address } from '@hyperlane-xyz/utils';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '../../providers/ConfiguredMultiProtocolProvider.js';
import type { ChainName } from '../../types.js';

import type { TokenConnection } from '../TokenConnection.js';
import { TokenConnectionType } from '../TokenConnection.js';
import type { TokenStandard } from '../TokenStandard.js';

export interface HypTokenAdapterInput {
  chainName: ChainName;
  addressOrDenom: Address | string;
  standard?: TokenStandard | string;
  collateralAddressOrDenom?: Address | string;
  connections?: Array<TokenConnection>;
}

export function hasOnlyHyperlaneConnections(token: HypTokenAdapterInput) {
  return (
    !!token.connections?.length &&
    token.connections.every(
      (connection) =>
        !connection.type || connection.type === TokenConnectionType.Hyperlane,
    )
  );
}

export function hasChainMetadata(
  multiProvider: MultiProtocolProvider,
  chainName: ChainName,
): boolean {
  return !!multiProvider.tryGetChainMetadata(chainName);
}
