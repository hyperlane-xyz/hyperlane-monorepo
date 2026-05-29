import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ArtifactReader } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedFeeAddress,
  DeployedFeeArtifact,
  FeeArtifactConfig,
  FeeReadContext,
  IRawFeeArtifactManager,
} from '@hyperlane-xyz/provider-sdk/fee';

/**
 * Factory function to create a FeeReader instance.
 * Returns null if the protocol does not support fee programs.
 *
 * @param chainMetadata Chain metadata for the target chain
 * @param context Required fee read context with domains and routers to check
 * @returns A FeeReader instance, or null if the protocol does not support fees
 */
export function createFeeReader(
  chainMetadata: ChainMetadataForAltVM,
  context: FeeReadContext,
): FeeReader | null {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawFeeArtifactManager | null =
    protocolProvider.createFeeArtifactManager(chainMetadata);

  if (!artifactManager) {
    return null;
  }

  return new FeeReader(artifactManager, context);
}

/**
 * Generic Fee Reader that reads fee configurations from on-chain state.
 *
 * The FeeReadContext is required at construction time to ensure the reader always
 * knows which domains and routers to check (some fee contracts are not enumerable).
 */
export class FeeReader implements ArtifactReader<
  FeeArtifactConfig,
  DeployedFeeAddress
> {
  constructor(
    protected readonly artifactManager: IRawFeeArtifactManager,
    protected readonly context: FeeReadContext,
  ) {}

  async read(address: string): Promise<DeployedFeeArtifact> {
    return this.artifactManager.readFee(address, this.context);
  }
}
