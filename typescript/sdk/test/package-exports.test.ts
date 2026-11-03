import { expect } from 'chai';
import { Connection } from '@solana/web3.js';
import { zeroAddress, zeroHash } from 'viem';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { EvmQuotedTransferProvider } from '@hyperlane-xyz/sdk/quoted-calls/EvmQuotedTransferProvider';
import type { QuotedTransferProvider } from '@hyperlane-xyz/sdk/quoted-calls/QuotedTransferProvider';
import {
  SealevelQuotedTransferProvider,
  type SealevelQuotedTransferProviderOpts,
} from '@hyperlane-xyz/sdk/quoted-calls/SealevelQuotedTransferProvider';
import { FeeQuotingV2Client } from '@hyperlane-xyz/sdk/quoted-calls/client';
import { TokenPullMode } from '@hyperlane-xyz/sdk/quoted-calls/types';

describe('quoted transfer provider subpath exports', () => {
  it('exports the EVM implementation with the public provider interface', () => {
    const provider: QuotedTransferProvider = new EvmQuotedTransferProvider({
      address: zeroAddress,
      clientSalt: zeroHash,
      quotes: [],
      tokenPullMode: TokenPullMode.TransferFrom,
    });
    expect(provider.protocol).to.equal(ProtocolType.Ethereum);
  });

  it('exports the Sealevel implementation and constructor options', () => {
    const options: SealevelQuotedTransferProviderOpts = {
      feeQuotingClient: new FeeQuotingV2Client({
        baseUrl: 'http://localhost',
        apiKey: 'test',
      }),
      connection: new Connection('http://localhost:8899'),
    };
    const provider: QuotedTransferProvider = new SealevelQuotedTransferProvider(
      options,
    );
    expect(provider.protocol).to.equal(ProtocolType.Sealevel);
  });
});
