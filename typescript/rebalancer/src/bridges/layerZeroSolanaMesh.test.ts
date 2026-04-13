import { expect } from 'chai';

import { PublicKey } from '@solana/web3.js';

import {
  createUsdt0QuoteOftInstruction,
  createUsdt0QuoteSendInstruction,
  createUsdt0SendInstruction,
  decodeUsdt0OftStoreAccount,
  decodeUsdt0PeerAddress,
  deriveUsdt0MeshPdas,
} from './layerZeroSolanaMesh.js';

const PROGRAM_ID = new PublicKey(
  'Fuww9mfc8ntAwxPUzFia7VJFAdvLppyZwhPJoXySZXf7',
);
const STORE_DATA = Buffer.from(
  'w9dohrnD8HLOAQ5gr+2yJxe9YxkvVBRaP5ZaM7uC0scCnrLOHiCCZNAnhPzb0dgwIgMjtslOS5vaY2UZfG8uBEDRf/AsT0fDWq122lFLbh3PEQN+kE2sPTdfUlyfuvyxlQe3iQfYwYv9I5hosQIAAAAHPspydHKXIRvHRBbeiQ4RvaY9FSU7slYCRRIXHVuOiv0XYChshm2UvRatoyeXd9N3RsC++nnQtxYoMgG9HAif1UcENPR//ubmmz+PwVSL9lSyVJTT+Empf4OhZRb4Ii9o89jxZJZgqb/eu9E4w6Xk5rU5ToSl50orUMBSdLJ1ZgMAAVkMo5OXbjMi2t6R0kT9kuPKNOSm/oWUF892gVkWEgsh',
  'base64',
);
const PEER_DATA = Buffer.from(
  'tZ1WxiHBXssAAAAAAAAAAAAAAAB3ZS1aughhN7WVh1Jj/CABgpGbkhYAAAAAAwEAEQEAAAAAAAAAAAAAAAAAAw1AFgAAAAADAQARAQAAAAAAAAAAAAAAAAADDUAWAAAAAAMBABEBAAAAAAAAAAAAAAAAAAMNQBYAAAAAAwEAEQEAAAAAAAAAAAAAAAAAAw1A/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  'base64',
);

describe('layerZeroSolanaMesh', function () {
  it('derives the live USDT0 mesh PDAs', () => {
    const pdas = deriveUsdt0MeshPdas(PROGRAM_ID, 30110);

    expect(pdas.oftStore.toBase58()).to.equal(
      'HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN',
    );
    expect(pdas.credits.toBase58()).to.equal(
      '6trV82jqtcqrsMd5ZXKvR6QzLX6bHstBK4wZFx1qrffC',
    );
    expect(pdas.peer.toBase58()).to.equal(
      '5FEMXXjueR7y6Z1uVDxTm4ZZXFp6XnxR1Xu1WmvwjxBF',
    );
  });

  it('decodes the live OFTStore layout', () => {
    const store = decodeUsdt0OftStoreAccount(STORE_DATA);

    expect(store.tokenMint.toBase58()).to.equal(
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    );
    expect(store.tokenEscrow.toBase58()).to.equal(
      'F1YkdxaiLA1eJt12y3uMAQef48Td3zdJfYhzjphma8hG',
    );
    expect(store.endpointProgram.toBase58()).to.equal(
      '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6',
    );
    expect(store.feeBps).to.equal(3);
    expect(store.lookupTable?.toBase58()).to.equal(
      '6zcTrmdkiQp6dZHYUxVr6A2XVDSYi44X1rcPtvwNcrXi',
    );
  });

  it('decodes the live peer receiver bytes', () => {
    const peerAddress = decodeUsdt0PeerAddress(PEER_DATA);

    expect(Buffer.from(peerAddress).toString('hex')).to.equal(
      '00000000000000000000000077652d5aba086137b595875263fc200182919b92',
    );
  });

  it('builds quote instructions with the USDT0 account set', () => {
    const { oftStore, credits, peer } = deriveUsdt0MeshPdas(PROGRAM_ID, 30110);
    const remaining = [
      {
        pubkey: new PublicKey('11111111111111111111111111111111'),
        isSigner: false,
        isWritable: false,
      },
    ];
    const params = {
      dstEid: 30110,
      to: Uint8Array.from(Buffer.alloc(32, 7)),
      amountLd: 10n,
      minAmountLd: 9n,
      options: Uint8Array.from([1, 2, 3]),
      composeMsg: Uint8Array.from([4, 5]),
      payInLzToken: false,
    };

    const quoteOftIx = createUsdt0QuoteOftInstruction(
      PROGRAM_ID,
      { oftStore, credits, peer },
      params,
    );
    const quoteSendIx = createUsdt0QuoteSendInstruction(
      PROGRAM_ID,
      { oftStore, credits, peer },
      params,
      remaining,
    );

    expect(quoteOftIx.keys.map((key) => key.pubkey.toBase58())).to.deep.equal([
      oftStore.toBase58(),
      credits.toBase58(),
      peer.toBase58(),
    ]);
    expect(
      Buffer.from(quoteOftIx.data.subarray(0, 8)).toString('hex'),
    ).to.equal('b3ff5ccafb525276');
    expect(quoteSendIx.keys.map((key) => key.pubkey.toBase58())).to.deep.equal([
      oftStore.toBase58(),
      credits.toBase58(),
      peer.toBase58(),
      '11111111111111111111111111111111',
    ]);
    expect(
      Buffer.from(quoteSendIx.data.subarray(0, 8)).toString('hex'),
    ).to.equal('cf0031d6a0d34cd3');
  });

  it('builds send with credits and event authority', () => {
    const { oftStore, credits, peer, eventAuthority } = deriveUsdt0MeshPdas(
      PROGRAM_ID,
      30110,
    );
    const tokenMint = new PublicKey(
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    );
    const tokenEscrow = new PublicKey(
      'F1YkdxaiLA1eJt12y3uMAQef48Td3zdJfYhzjphma8hG',
    );
    const signer = new PublicKey('mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X');
    const tokenSource = new PublicKey(
      'BJE5MM3JYw84ZPQ4tJ8c8c1M5xgkCeWEc6x1T5Vb9f8y',
    );

    const sendIx = createUsdt0SendInstruction(
      PROGRAM_ID,
      {
        signer,
        peer,
        oftStore,
        credits,
        eventAuthority,
        tokenSource,
        tokenEscrow,
        tokenMint,
      },
      {
        dstEid: 30110,
        to: Uint8Array.from(Buffer.alloc(32, 9)),
        amountLd: 10n,
        minAmountLd: 9n,
        options: Uint8Array.from([1]),
        composeMsg: Uint8Array.from([2]),
        nativeFee: 3n,
        lzTokenFee: 0n,
      },
    );

    expect(sendIx.keys[0].pubkey.toBase58()).to.equal(signer.toBase58());
    expect(sendIx.keys[2].pubkey.toBase58()).to.equal(oftStore.toBase58());
    expect(sendIx.keys[3].pubkey.toBase58()).to.equal(credits.toBase58());
    expect(sendIx.keys[8].pubkey.toBase58()).to.equal(
      eventAuthority.toBase58(),
    );
    expect(sendIx.keys[9].pubkey.toBase58()).to.equal(PROGRAM_ID.toBase58());
    expect(Buffer.from(sendIx.data.subarray(0, 8)).toString('hex')).to.equal(
      '66fb14bb414b0c45',
    );
  });
});
