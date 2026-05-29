import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type IRawWarpQuoteArtifactManager,
  type IRawWarpQuoteReader,
  type IRawWarpQuoteWriter,
  type RawQuoteSigner,
} from '@hyperlane-xyz/provider-sdk/quote';

import type { SvmSigner } from '../clients/signer.js';

import { SvmQuoteReader } from './SvmQuoteReader.js';
import { SvmQuoteWriter, type SvmQuoteWriterConfig } from './SvmQuoteWriter.js';

/**
 * SVM implementation of `IRawWarpQuoteArtifactManager`. Forwards signer +
 * fee deployment coords to the writer / reader; the bound `SvmSigner` exposes
 * its RPC so the manager doesn't need a separate `rpc` parameter, matching
 * the alt-VM convention. `FeeReadContext` is bound at construction because
 * the reader's enumerator needs the same per-domain router data the fee
 * reader uses.
 */
export class SvmQuoteArtifactManager implements IRawWarpQuoteArtifactManager {
  constructor(
    private readonly txSigner: SvmSigner,
    private readonly config: SvmQuoteWriterConfig,
    private readonly context: FeeReadContext,
  ) {}

  createWriter(quoteSigner: RawQuoteSigner): IRawWarpQuoteWriter {
    return new SvmQuoteWriter(this.txSigner, quoteSigner, this.config);
  }

  createReader(): IRawWarpQuoteReader {
    return new SvmQuoteReader(this.txSigner, this.config, this.context);
  }
}
