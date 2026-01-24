import { expect } from 'chai';

import {
  SQUADS_ACCOUNT_DISCRIMINATORS,
  SQUADS_ACCOUNT_DISCRIMINATOR_SIZE,
  SquadsAccountType,
  decodePermissions,
  isConfigTransaction,
  isVaultTransaction,
} from './squads.js';

describe('Squads helpers', () => {
  it('detects VaultTransaction discriminators', () => {
    const data = Buffer.concat([
      Buffer.from(SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT]),
      Buffer.alloc(4, 0),
    ]);

    expect(data.length).to.be.greaterThan(SQUADS_ACCOUNT_DISCRIMINATOR_SIZE);
    expect(isVaultTransaction(data)).to.be.true;
    expect(isConfigTransaction(data)).to.be.false;
  });

  it('detects ConfigTransaction discriminators', () => {
    const data = Buffer.concat([
      Buffer.from(SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG]),
      Buffer.alloc(4, 0),
    ]);

    expect(data.length).to.be.greaterThan(SQUADS_ACCOUNT_DISCRIMINATOR_SIZE);
    expect(isConfigTransaction(data)).to.be.true;
    expect(isVaultTransaction(data)).to.be.false;
  });

  it('decodes permission masks', () => {
    expect(decodePermissions(0)).to.equal('None');
    expect(decodePermissions(1)).to.equal('Proposer');
    expect(decodePermissions(3)).to.equal('Proposer, Voter');
  });
});
