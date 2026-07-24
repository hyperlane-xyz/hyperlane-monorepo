import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type IRawWarpQuoteArtifactManager,
  type IRawWarpQuoteReader,
  type IRawWarpQuoteWriter,
  type RawQuoteSigner,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { type SvmRpc } from '../types.js';

import { SvmQuoteReader } from './SvmQuoteReader.js';
import { SvmQuoteWriter, type SvmQuoteWriterConfig } from './SvmQuoteWriter.js';

/**
 * SVM implementation of `IRawWarpQuoteArtifactManager`. Matches the
 * `SvmFeeArtifactManager` / `SvmWarpArtifactManager` convention:
 * the constructor only carries the read-side dependency (`rpc`), and
 * `createWriter` accepts the tx signer as a method parameter so read-only
 * callers don't need a signer at construction time.
 */
export class SvmQuoteArtifactManager implements IRawWarpQuoteArtifactManager {
  constructor(
    private readonly rpc: SvmRpc,
    private readonly config: SvmQuoteWriterConfig,
    private readonly context: FeeReadContext,
  ) {}

  createWriter(
    quoteSigner: RawQuoteSigner,
    txSigner: unknown,
  ): IRawWarpQuoteWriter {
    assert(
      txSigner instanceof SvmSigner,
      'SvmQuoteArtifactManager.createWriter requires an SvmSigner',
    );
    return new SvmQuoteWriter(txSigner, quoteSigner, this.config);
  }

  createReader(): IRawWarpQuoteReader {
    return new SvmQuoteReader(this.rpc, this.config, this.context);
  }
}
