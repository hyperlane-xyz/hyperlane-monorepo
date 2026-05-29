import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type IRawWarpQuoteArtifactManager,
  type IRawWarpQuoteReader,
  type IRawWarpQuoteWriter,
  type RawQuoteSigner,
} from '@hyperlane-xyz/provider-sdk/quote';

import type { SvmSigner } from '../clients/signer.js';

import { SvmQuoteWriter, type SvmQuoteWriterConfig } from './SvmQuoteWriter.js';

/**
 * SVM implementation of `IRawWarpQuoteArtifactManager`. Forwards signer +
 * fee deployment coords to the writer / reader; the bound `SvmSigner` exposes
 * its RPC so the writer doesn't need a separate `rpc` parameter.
 *
 * The reader is added in the follow-up commit alongside `SvmQuoteReader`;
 * `createReader()` throws here so callers fail loudly during the interim,
 * and the `FeeReadContext` parameter the reader will need is accepted now
 * to lock the constructor signature.
 */
export class SvmQuoteArtifactManager implements IRawWarpQuoteArtifactManager {
  constructor(
    private readonly txSigner: SvmSigner,
    private readonly config: SvmQuoteWriterConfig,
    _context: FeeReadContext,
  ) {}

  createWriter(quoteSigner: RawQuoteSigner): IRawWarpQuoteWriter {
    return new SvmQuoteWriter(this.txSigner, quoteSigner, this.config);
  }

  createReader(): IRawWarpQuoteReader {
    throw new Error('SvmQuoteReader is not yet implemented.');
  }
}
