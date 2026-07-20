import { ethers } from 'ethers';

import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type IRawWarpQuoteArtifactManager,
  type IRawWarpQuoteReader,
  type IRawWarpQuoteWriter,
  type RawQuoteSigner,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import { type MultiProvider } from '../providers/MultiProvider.js';

import { EvmQuoteReader } from './EvmQuoteReader.js';
import { EvmQuoteWriter } from './EvmQuoteWriter.js';

/**
 * EVM implementation of `IRawWarpQuoteArtifactManager`. The constructor only
 * carries the read-side dependency (`multiProvider`) so read-only callers
 * (`warp quote read`) don't need a tx signer. `createWriter` accepts the
 * `ethers.Signer` as a method parameter, matching the alt-VM artifact
 * manager convention.
 */
export class EvmQuoteArtifactManager implements IRawWarpQuoteArtifactManager {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly chainName: string,
    private readonly feeAddress: string,
    private readonly context: FeeReadContext,
  ) {}

  createWriter(
    quoteSigner: RawQuoteSigner,
    txSigner: unknown,
  ): IRawWarpQuoteWriter {
    assert(
      txSigner instanceof ethers.Signer,
      'EvmQuoteArtifactManager.createWriter requires an ethers.Signer',
    );
    return new EvmQuoteWriter(txSigner, quoteSigner, this.feeAddress);
  }

  createReader(): IRawWarpQuoteReader {
    const provider = this.multiProvider.getProvider(this.chainName);
    return new EvmQuoteReader(provider, this.feeAddress, this.context);
  }
}
