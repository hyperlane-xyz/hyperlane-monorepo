import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type IRawWarpQuoteArtifactManager,
  type IRawWarpQuoteReader,
} from '@hyperlane-xyz/provider-sdk/quote';

/**
 * Factory for an `IRawWarpQuoteReader`. Returns `null` when the protocol
 * does not (yet) register an offchain-quote artifact manager — legacy EVM
 * SDK consumers must bridge via the CLI factory.
 */
export function createWarpQuoteReader(
  chainMetadata: ChainMetadataForAltVM,
  context: FeeReadContext,
): IRawWarpQuoteReader | null {
  const provider = getProtocolProvider(chainMetadata.protocol);
  const manager: IRawWarpQuoteArtifactManager | null =
    provider.createQuoteArtifactManager(chainMetadata, context);
  return manager ? manager.createReader() : null;
}
