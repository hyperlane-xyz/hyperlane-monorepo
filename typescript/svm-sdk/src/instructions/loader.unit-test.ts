import { AccountRole, address as parseAddress } from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { assert } from '@hyperlane-xyz/utils';

import {
  LOADER_V3_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';

import { getExtendProgramInstruction } from './loader.js';

const PROGRAM_DATA = parseAddress(
  '2WGCyJhWKLrfKyoLVKiuWTJq9MgbdBcNvoYRLMa2ca1P',
);
const PROGRAM = parseAddress('W8HjXMH7Vxog7zrXuoFxHmzj3X5YWZuhsbW3n66fSiY');
const PAYER = parseAddress('Fkf5uWVPjj8Dvg716mUYQ2tRpeZpGhib8qme4k34uZy3');

describe('getExtendProgramInstruction', () => {
  const additionalBytes = 10_240;
  const ix = getExtendProgramInstruction(
    PROGRAM_DATA,
    PROGRAM,
    PAYER,
    additionalBytes,
  );

  it('targets the upgradeable loader', () => {
    expect(ix.programAddress).to.equal(LOADER_V3_PROGRAM_ADDRESS);
  });

  it('encodes variant 6 and the additional bytes as u32le', () => {
    assert(ix.data, 'instruction data should be set');
    const data = Buffer.from(ix.data);
    expect(data.length).to.equal(8);
    expect(data.readUInt32LE(0)).to.equal(6);
    expect(data.readUInt32LE(4)).to.equal(additionalBytes);
  });

  it('lists the ExtendProgram accounts in order with correct roles', () => {
    expect(ix.accounts).to.deep.equal([
      { address: PROGRAM_DATA, role: AccountRole.WRITABLE },
      { address: PROGRAM, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
    ]);
  });
});
