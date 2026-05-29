import {
  type IRawWarpQuoteArtifactManager,
  type IRawWarpQuoteReader,
  type IRawWarpQuoteWriter,
  type RawQuoteSigner,
} from '@hyperlane-xyz/provider-sdk/quote';

import { type MultiProvider } from '../providers/MultiProvider.js';

import { EvmQuoteWriter } from './EvmQuoteWriter.js';

/**
 * EVM implementation of `IRawWarpQuoteArtifactManager`. Resolves the
 * tx-submitter from `multiProvider` and forwards the configured `feeAddress`
 * to the writer.
 *
 * The reader is added in the follow-up commit alongside `EvmQuoteReader`;
 * `createReader()` throws here so callers fail loudly during the interim.
 */
export class EvmQuoteArtifactManager implements IRawWarpQuoteArtifactManager {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly chainName: string,
    private readonly feeAddress: string,
  ) {}

  createWriter(quoteSigner: RawQuoteSigner): IRawWarpQuoteWriter {
    const txSigner = this.multiProvider.getSigner(this.chainName);
    return new EvmQuoteWriter(txSigner, quoteSigner, this.feeAddress);
  }

  createReader(): IRawWarpQuoteReader {
    throw new Error('EvmQuoteReader is not yet implemented.');
  }
}
