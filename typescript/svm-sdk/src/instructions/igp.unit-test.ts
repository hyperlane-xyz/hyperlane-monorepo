import {
  type Address,
  address as parseAddress,
  generateKeyPairSigner,
} from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { SetQuoteSignerOp, type SvmSignedQuote } from '../codecs/fee.js';
import {
  type GetIgpQuoteAccountMetasInput,
  type IgpFeeConfig,
} from '../codecs/igp.js';

import {
  decodeIgpProgramInstruction,
  encodeIgpProgramInstruction,
  getCloseIgpStandingQuoteInstruction,
  getCloseIgpTransientQuoteInstruction,
  getGetIgpQuoteAccountMetasInstruction,
  getSetIgpMinIssuedAtInstruction,
  getSetIgpQuoteConfigInstruction,
  getSetIgpQuoteSignerInstruction,
  getSubmitIgpQuoteInstruction,
  IgpInstructionKind,
  type IgpProgramInstructionData,
} from './igp.js';

const PROGRAM: Address = parseAddress(
  'GZGLpeuMaUXUmBHh1EtgWQDufyUoHapAKFfgKb6u8o3h',
);
const OWNER: Address = parseAddress(
  '2nss3sLwiUCP98rXQ6FciJ35cDeSLu3VEU5mFRa7p43J',
);
const IGP_ACCOUNT: Address = parseAddress(
  'EALSQwzJFwRbjDjBkwNziHXnowfgwt9ixKapKiudGa45',
);
const QUOTE_PDA: Address = parseAddress(
  '7obrq5PaqcwHtZSSirTNLgwxiEYCjabyQvbYDVsaD61H',
);
const SENDER: Address = parseAddress(
  '4ZiKsHnTUbgH97sMggds4NfV31yBB3hsJJEKk1Fj8NyL',
);
const SIGNER_HEX = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const SAMPLE_QUOTE: SvmSignedQuote = {
  context: new Uint8Array([1, 2, 3, 4]),
  data: new Uint8Array([5, 6]),
  issuedAt: new Uint8Array([0, 0, 0, 1, 0, 0]),
  expiry: new Uint8Array([0, 0, 0, 2, 0, 0]),
  clientSalt: new Uint8Array(32).fill(7),
  signature: new Uint8Array(65).fill(8),
};

function roundTrip(
  data: IgpProgramInstructionData,
): IgpProgramInstructionData | null {
  const bytes = Uint8Array.from(encodeIgpProgramInstruction(data));
  return decodeIgpProgramInstruction(bytes);
}

describe('IgpProgramInstructionData round-trip — admin variants', () => {
  it('SetIgpQuoteConfig with Some round-trips', () => {
    const config: IgpFeeConfig = {
      signers: [SIGNER_HEX],
      domainId: 137,
      minIssuedAt: 1_700_000_000n,
    };
    const data: IgpProgramInstructionData = {
      kind: 'setIgpQuoteConfig',
      config,
    };
    expect(roundTrip(data)).to.eql(data);
  });

  it('SetIgpQuoteConfig with null round-trips', () => {
    const data: IgpProgramInstructionData = {
      kind: 'setIgpQuoteConfig',
      config: null,
    };
    expect(roundTrip(data)).to.eql(data);
  });

  for (const [opName, op] of [
    ['Add', SetQuoteSignerOp.Add],
    ['Remove', SetQuoteSignerOp.Remove],
  ] as const) {
    it(`SetIgpQuoteSigner ${opName} round-trips`, () => {
      const data: IgpProgramInstructionData = {
        kind: 'setIgpQuoteSigner',
        operation: op,
        signer: SIGNER_HEX,
      };
      expect(roundTrip(data)).to.eql(data);
    });
  }

  for (const minIssuedAt of [
    0n,
    1_700_000_000n,
    -1n,
    9_223_372_036_854_775_807n,
  ] as const) {
    it(`SetIgpMinIssuedAt ${minIssuedAt} round-trips`, () => {
      const data: IgpProgramInstructionData = {
        kind: 'setIgpMinIssuedAt',
        minIssuedAt,
      };
      expect(roundTrip(data)).to.eql(data);
    });
  }
});

describe('IGP admin instruction builders — discriminator + accounts', () => {
  it('getSetIgpQuoteConfigInstruction prefixes data with kind 11', async () => {
    const ix = await getSetIgpQuoteConfigInstruction(
      PROGRAM,
      OWNER,
      IGP_ACCOUNT,
      null,
    );
    expect(ix.data?.[0]).to.equal(IgpInstructionKind.SetIgpQuoteConfig);
    expect(ix.accounts).to.have.length(3);
    expect(ix.accounts?.[2]?.address).to.equal(OWNER);
  });

  it('getSetIgpQuoteSignerInstruction prefixes data with kind 12', async () => {
    const ix = await getSetIgpQuoteSignerInstruction(
      PROGRAM,
      OWNER,
      IGP_ACCOUNT,
      SetQuoteSignerOp.Add,
      SIGNER_HEX,
    );
    expect(ix.data?.[0]).to.equal(IgpInstructionKind.SetIgpQuoteSigner);
    expect(ix.accounts).to.have.length(3);
    expect(ix.accounts?.[2]?.address).to.equal(OWNER);
  });

  it('getSetIgpMinIssuedAtInstruction prefixes data with kind 13', async () => {
    const ix = await getSetIgpMinIssuedAtInstruction(
      PROGRAM,
      OWNER,
      IGP_ACCOUNT,
      0n,
    );
    expect(ix.data?.[0]).to.equal(IgpInstructionKind.SetIgpMinIssuedAt);
    expect(ix.accounts).to.have.length(3);
    expect(ix.accounts?.[2]?.address).to.equal(OWNER);
  });
});

describe('IgpProgramInstructionData round-trip — quote lifecycle variants', () => {
  it('SubmitIgpQuote round-trips', () => {
    const data: IgpProgramInstructionData = {
      kind: 'submitIgpQuote',
      quote: SAMPLE_QUOTE,
    };
    expect(roundTrip(data)).to.eql(data);
  });

  it('CloseIgpTransientQuote round-trips', () => {
    const data: IgpProgramInstructionData = { kind: 'closeIgpTransientQuote' };
    expect(roundTrip(data)).to.eql(data);
  });

  it('CloseIgpStandingQuote round-trips', () => {
    const data: IgpProgramInstructionData = { kind: 'closeIgpStandingQuote' };
    expect(roundTrip(data)).to.eql(data);
  });

  it('GetIgpQuoteAccountMetas with scopedSalt round-trips', () => {
    const input: GetIgpQuoteAccountMetasInput = {
      destinationDomain: 137,
      sender: SENDER,
      scopedSalt: new Uint8Array(32).fill(9),
    };
    const data: IgpProgramInstructionData = {
      kind: 'getIgpQuoteAccountMetas',
      input,
    };
    expect(roundTrip(data)).to.eql(data);
  });

  it('GetIgpQuoteAccountMetas without scopedSalt round-trips', () => {
    const input: GetIgpQuoteAccountMetasInput = {
      destinationDomain: 1,
      sender: SENDER,
    };
    const data: IgpProgramInstructionData = {
      kind: 'getIgpQuoteAccountMetas',
      input,
    };
    expect(roundTrip(data)).to.eql(data);
  });
});

describe('IGP quote-lifecycle instruction builders — discriminator + accounts', () => {
  it('getSubmitIgpQuoteInstruction prefixes data with kind 14 and orders accounts [system, payer, igp, quotePda]', async () => {
    const payer = await generateKeyPairSigner();
    const ix = await getSubmitIgpQuoteInstruction(
      PROGRAM,
      payer,
      IGP_ACCOUNT,
      QUOTE_PDA,
      SAMPLE_QUOTE,
    );
    expect(ix.data?.[0]).to.equal(IgpInstructionKind.SubmitIgpQuote);
    expect(ix.accounts).to.have.length(4);
    expect(ix.accounts?.[1]?.address).to.equal(payer.address);
    expect(ix.accounts?.[2]?.address).to.equal(IGP_ACCOUNT);
    expect(ix.accounts?.[3]?.address).to.equal(QUOTE_PDA);
  });

  it('getCloseIgpTransientQuoteInstruction prefixes data with kind 15 and orders accounts [transientPda, payer, igp]', async () => {
    const payer = await generateKeyPairSigner();
    const ix = await getCloseIgpTransientQuoteInstruction(
      PROGRAM,
      QUOTE_PDA,
      payer,
      IGP_ACCOUNT,
    );
    expect(ix.data?.[0]).to.equal(IgpInstructionKind.CloseIgpTransientQuote);
    expect(ix.accounts).to.have.length(3);
    expect(ix.accounts?.[0]?.address).to.equal(QUOTE_PDA);
    expect(ix.accounts?.[1]?.address).to.equal(payer.address);
    expect(ix.accounts?.[2]?.address).to.equal(IGP_ACCOUNT);
  });

  it('getCloseIgpStandingQuoteInstruction prefixes data with kind 16 and orders accounts [standingPda, igp, beneficiary]', async () => {
    const ix = await getCloseIgpStandingQuoteInstruction(
      PROGRAM,
      QUOTE_PDA,
      IGP_ACCOUNT,
      OWNER,
    );
    expect(ix.data?.[0]).to.equal(IgpInstructionKind.CloseIgpStandingQuote);
    expect(ix.accounts).to.have.length(3);
    expect(ix.accounts?.[0]?.address).to.equal(QUOTE_PDA);
    expect(ix.accounts?.[1]?.address).to.equal(IGP_ACCOUNT);
    expect(ix.accounts?.[2]?.address).to.equal(OWNER);
  });

  it('getGetIgpQuoteAccountMetasInstruction prefixes data with kind 17 and only includes the IGP account', async () => {
    const ix = await getGetIgpQuoteAccountMetasInstruction(
      PROGRAM,
      IGP_ACCOUNT,
      { destinationDomain: 1, sender: SENDER },
    );
    expect(ix.data?.[0]).to.equal(IgpInstructionKind.GetIgpQuoteAccountMetas);
    expect(ix.accounts).to.have.length(1);
    expect(ix.accounts?.[0]?.address).to.equal(IGP_ACCOUNT);
  });
});
