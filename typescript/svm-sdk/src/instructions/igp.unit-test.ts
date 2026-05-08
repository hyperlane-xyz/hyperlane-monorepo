import { type Address, address as parseAddress } from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { SetQuoteSignerOp } from '../codecs/fee.js';
import { type IgpFeeConfig } from '../codecs/igp.js';

import {
  decodeIgpProgramInstruction,
  encodeIgpProgramInstruction,
  getSetIgpMinIssuedAtInstruction,
  getSetIgpQuoteConfigInstruction,
  getSetIgpQuoteSignerInstruction,
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
const SIGNER_HEX = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
