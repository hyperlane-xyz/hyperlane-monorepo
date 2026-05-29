import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type IRawWarpQuoteArtifactManager,
  type IRawWarpQuoteWriter,
  type RawQuoteSigner,
} from '@hyperlane-xyz/provider-sdk/quote';

/**
 * Factory for an `IRawWarpQuoteWriter`. Returns `null` when the protocol
 * does not (yet) register an offchain-quote artifact manager — legacy EVM
 * SDK consumers must bridge via the CLI factory.
 */
export function createWarpQuoteWriter(
  chainMetadata: ChainMetadataForAltVM,
  signer: RawQuoteSigner,
  context: FeeReadContext,
): IRawWarpQuoteWriter | null {
  const provider = getProtocolProvider(chainMetadata.protocol);
  const manager: IRawWarpQuoteArtifactManager | null =
    provider.createQuoteArtifactManager(chainMetadata, context);
  return manager ? manager.createWriter(signer) : null;
}
