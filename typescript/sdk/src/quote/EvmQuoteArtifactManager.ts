import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type IRawWarpQuoteArtifactManager,
  type IRawWarpQuoteReader,
  type IRawWarpQuoteWriter,
  type RawQuoteSigner,
} from '@hyperlane-xyz/provider-sdk/quote';

import { type MultiProvider } from '../providers/MultiProvider.js';

import { EvmQuoteReader } from './EvmQuoteReader.js';
import { EvmQuoteWriter } from './EvmQuoteWriter.js';

/**
 * EVM implementation of `IRawWarpQuoteArtifactManager`. Resolves the
 * tx-submitter / read-only provider from `multiProvider` and forwards the
 * configured `feeAddress` to the writer and reader. `FeeReadContext` is bound
 * at construction because the reader's enumerator needs the same per-domain
 * router data the fee reader uses.
 */
export class EvmQuoteArtifactManager implements IRawWarpQuoteArtifactManager {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly chainName: string,
    private readonly feeAddress: string,
    private readonly context: FeeReadContext,
  ) {}

  createWriter(quoteSigner: RawQuoteSigner): IRawWarpQuoteWriter {
    const txSigner = this.multiProvider.getSigner(this.chainName);
    return new EvmQuoteWriter(txSigner, quoteSigner, this.feeAddress);
  }

  createReader(): IRawWarpQuoteReader {
    const provider = this.multiProvider.getProvider(this.chainName);
    return new EvmQuoteReader(provider, this.feeAddress, this.context);
  }
}
