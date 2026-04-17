import {
  ChainMetadataForAltVM,
  getProtocolProvider,
} from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactNew,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedFeeAddress,
  DeployedFeeArtifact,
  FeeArtifactConfig,
  FeeReadContext,
  IRawFeeArtifactManager,
} from '@hyperlane-xyz/provider-sdk/fee';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { FeeReader } from './fee-reader.js';

/**
 * Factory function to create a FeeWriter instance.
 * Returns null if the protocol does not support fee programs.
 *
 * @param chainMetadata Chain metadata for the target chain
 * @param signer Signer interface for signing transactions
 * @param context Required fee read context with domains and routers to check
 * @returns A FeeWriter instance, or null if the protocol does not support fees
 */
export function createFeeWriter(
  chainMetadata: ChainMetadataForAltVM,
  signer: ISigner<AnnotatedTx, TxReceipt>,
  context: FeeReadContext,
): FeeWriter | null {
  const protocolProvider = getProtocolProvider(chainMetadata.protocol);
  const artifactManager: IRawFeeArtifactManager | null =
    protocolProvider.createFeeArtifactManager(chainMetadata);

  if (!artifactManager) {
    return null;
  }

  return new FeeWriter(artifactManager, context, signer);
}

/**
 * FeeWriter handles creation and updates of fee configurations using the Artifact API.
 * It delegates to protocol-specific artifact writers for individual fee types.
 *
 * Extends FeeReader to inherit read() functionality.
 * The FeeReadContext is required at construction time to ensure the reader always
 * knows which domains and routers to check (some fee contracts are not enumerable).
 */
export class FeeWriter
  extends FeeReader
  implements ArtifactWriter<FeeArtifactConfig, DeployedFeeAddress>
{
  constructor(
    protected readonly artifactManager: IRawFeeArtifactManager,
    protected readonly context: FeeReadContext,
    protected readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(artifactManager, context);
  }

  async create(
    artifact: ArtifactNew<FeeArtifactConfig>,
  ): Promise<[DeployedFeeArtifact, TxReceipt[]]> {
    const { config } = artifact;
    const writer = this.artifactManager.createWriter(config.type, this.signer);
    return writer.create(artifact);
  }

  async update(artifact: DeployedFeeArtifact): Promise<AnnotatedTx[]> {
    const { config } = artifact;
    const writer = this.artifactManager.createWriter(config.type, this.signer);
    return writer.update(artifact);
  }
}
