import { expect } from 'chai';

import {
  SquadTxStatus,
  SquadsAccountType,
  SquadsPermission,
  SquadsProposalStatus,
  SQUADS_ACCOUNT_DISCRIMINATORS,
  decodePermissions,
  getSquadTxStatus,
  isConfigTransaction,
  isVaultTransaction,
} from './squads.js';

describe('decodePermissions', () => {
  it('decodes individual permissions', () => {
    expect(decodePermissions(SquadsPermission.PROPOSER)).to.equal('Proposer');
    expect(decodePermissions(SquadsPermission.VOTER)).to.equal('Voter');
    expect(decodePermissions(SquadsPermission.EXECUTOR)).to.equal('Executor');
  });

  it('decodes combined permissions', () => {
    expect(
      decodePermissions(SquadsPermission.VOTER | SquadsPermission.EXECUTOR),
    ).to.equal('Voter, Executor');
  });

  it('returns None when no permissions', () => {
    expect(decodePermissions(0)).to.equal('None');
  });
});

describe('getSquadTxStatus', () => {
  it('returns stale when transaction index is stale', () => {
    const status = getSquadTxStatus(
      SquadsProposalStatus.Active,
      0,
      2,
      1,
      2,
    );
    expect(status).to.equal(SquadTxStatus.STALE);
  });

  it('returns approved when approvals meet threshold', () => {
    const status = getSquadTxStatus(
      SquadsProposalStatus.Active,
      2,
      2,
      5,
      0,
    );
    expect(status).to.equal(SquadTxStatus.APPROVED);
  });

  it('returns one away when one approval short', () => {
    const status = getSquadTxStatus(
      SquadsProposalStatus.Active,
      1,
      2,
      5,
      0,
    );
    expect(status).to.equal(SquadTxStatus.ONE_AWAY);
  });

  it('returns active when pending and not one away', () => {
    const status = getSquadTxStatus(
      SquadsProposalStatus.Active,
      0,
      3,
      5,
      0,
    );
    expect(status).to.equal(SquadTxStatus.ACTIVE);
  });
});

describe('isVaultTransaction', () => {
  it('detects vault discriminator', () => {
    const data = Buffer.concat([
      Buffer.from(SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT]),
      Buffer.from([0, 1, 2]),
    ]);
    expect(isVaultTransaction(data)).to.equal(true);
    expect(isConfigTransaction(data)).to.equal(false);
  });

  it('detects config discriminator', () => {
    const data = Buffer.concat([
      Buffer.from(SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG]),
      Buffer.from([0, 1, 2]),
    ]);
    expect(isConfigTransaction(data)).to.equal(true);
    expect(isVaultTransaction(data)).to.equal(false);
  });
});
