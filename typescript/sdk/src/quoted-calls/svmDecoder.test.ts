import { expect } from 'chai';
import { hexToBytes } from 'viem';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { decodeSealevelQuoteEntry } from './svmDecoder.js';
import type { SealevelQuoteV2Entry } from './types.js';

describe('decodeSealevelQuoteEntry', () => {
  const SEALEVEL_QUOTE: SealevelQuoteV2Entry = {
    protocol: ProtocolType.Sealevel,
    quoter: '11111111111111111111111111111111',
    issuedAt: 1700000000,
    expiry: 1700003600,
    details: {
      domainId: 1399811149,
      signedQuote: {
        context: `0x${'11'.repeat(44)}`,
        data: `0x${'22'.repeat(8)}`,
        issuedAt: `0x${'33'.repeat(6)}`,
        expiry: `0x${'44'.repeat(6)}`,
        clientSalt: `0x${'55'.repeat(32)}`,
        signature: `0x${'66'.repeat(65)}`,
      },
    },
  };

  it('decodes every hex byte field to Uint8Array of the right length', () => {
    const decoded = decodeSealevelQuoteEntry(SEALEVEL_QUOTE);

    expect(decoded.signedQuote.context).to.deep.equal(
      hexToBytes(SEALEVEL_QUOTE.details.signedQuote.context),
    );
    expect(decoded.signedQuote.context.length).to.equal(44);

    expect(decoded.signedQuote.data.length).to.equal(8);

    expect(decoded.signedQuote.issuedAt.length).to.equal(6);
    expect(decoded.signedQuote.expiry.length).to.equal(6);

    expect(decoded.signedQuote.clientSalt.length).to.equal(32);
    expect(decoded.signedQuote.signature.length).to.equal(65);
  });

  it('passes envelope fields through verbatim', () => {
    const decoded = decodeSealevelQuoteEntry(SEALEVEL_QUOTE);

    expect(decoded.quoter).to.equal(SEALEVEL_QUOTE.quoter);
    expect(decoded.domainId).to.equal(SEALEVEL_QUOTE.details.domainId);
    expect(decoded.issuedAt).to.equal(SEALEVEL_QUOTE.issuedAt);
    expect(decoded.expiry).to.equal(SEALEVEL_QUOTE.expiry);
  });

  it('preserves the transient discriminator (expiry === issuedAt) bit-for-bit', () => {
    const transient: SealevelQuoteV2Entry = {
      ...SEALEVEL_QUOTE,
      details: {
        ...SEALEVEL_QUOTE.details,
        signedQuote: {
          ...SEALEVEL_QUOTE.details.signedQuote,
          // transient: expiry === issuedAt at the u48 BE byte level
          expiry: SEALEVEL_QUOTE.details.signedQuote.issuedAt,
        },
      },
    };

    const decoded = decodeSealevelQuoteEntry(transient);
    expect(decoded.signedQuote.expiry).to.deep.equal(
      decoded.signedQuote.issuedAt,
    );
  });
});
