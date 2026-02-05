import { expect } from 'chai';

import {
  decodeSquadsPermissions,
  getSquadsTxStatus,
  isConfigTransaction,
  isVaultTransaction,
  SQUADS_ACCOUNT_DISCRIMINATORS,
} from './squads.js';
import {
  SquadsAccountType,
  SquadsPermission,
  SquadsProposalStatus,
  SquadsTxStatus,
} from './types.js';

describe('Squads Transaction Parsing', () => {
  describe('decodeSquadsPermissions', () => {
    it('should decode single permission', () => {
      expect(decodeSquadsPermissions(SquadsPermission.PROPOSER)).to.equal(
        'Proposer',
      );
      expect(decodeSquadsPermissions(SquadsPermission.VOTER)).to.equal('Voter');
      expect(decodeSquadsPermissions(SquadsPermission.EXECUTOR)).to.equal(
        'Executor',
      );
    });

    it('should decode multiple permissions', () => {
      const proposerVoter =
        SquadsPermission.PROPOSER | SquadsPermission.VOTER;
      expect(decodeSquadsPermissions(proposerVoter)).to.equal(
        'Proposer, Voter',
      );

      expect(
        decodeSquadsPermissions(SquadsPermission.ALL_PERMISSIONS),
      ).to.equal('Proposer, Voter, Executor');
    });

    it('should return None for zero permissions', () => {
      expect(decodeSquadsPermissions(0)).to.equal('None');
    });
  });

  describe('getSquadsTxStatus', () => {
    it('should return STALE for transactions below stale index', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Active, 2, 3, 5, 10),
      ).to.equal(SquadsTxStatus.STALE);
    });

    it('should not return STALE for Executed transactions below stale index', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Executed, 2, 3, 5, 10),
      ).to.equal(SquadsTxStatus.EXECUTED);
    });

    it('should return DRAFT for Draft status', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Draft, 0, 3, 15, 10),
      ).to.equal(SquadsTxStatus.DRAFT);
    });

    it('should return APPROVED when Active with enough approvals', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Active, 3, 3, 15, 10),
      ).to.equal(SquadsTxStatus.APPROVED);
    });

    it('should return ONE_AWAY when Active and one away from threshold', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Active, 2, 3, 15, 10),
      ).to.equal(SquadsTxStatus.ONE_AWAY);
    });

    it('should return ACTIVE when Active with not enough approvals', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Active, 1, 3, 15, 10),
      ).to.equal(SquadsTxStatus.ACTIVE);
    });

    it('should return REJECTED for Rejected status', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Rejected, 0, 3, 15, 10),
      ).to.equal(SquadsTxStatus.REJECTED);
    });

    it('should return APPROVED for Approved status', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Approved, 3, 3, 15, 10),
      ).to.equal(SquadsTxStatus.APPROVED);
    });

    it('should return EXECUTING for Executing status', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Executing, 3, 3, 15, 10),
      ).to.equal(SquadsTxStatus.EXECUTING);
    });

    it('should return EXECUTED for Executed status', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Executed, 3, 3, 15, 10),
      ).to.equal(SquadsTxStatus.EXECUTED);
    });

    it('should return CANCELLED for Cancelled status', () => {
      expect(
        getSquadsTxStatus(SquadsProposalStatus.Cancelled, 3, 3, 15, 10),
      ).to.equal(SquadsTxStatus.CANCELLED);
    });
  });

  describe('isVaultTransaction', () => {
    it('should return true for vault transaction discriminator', () => {
      const accountData = Buffer.alloc(100);
      accountData.set(
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
        0,
      );
      expect(isVaultTransaction(accountData)).to.be.true;
    });

    it('should return false for non-vault transaction discriminator', () => {
      const accountData = Buffer.alloc(100);
      accountData.set(
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        0,
      );
      expect(isVaultTransaction(accountData)).to.be.false;
    });
  });

  describe('isConfigTransaction', () => {
    it('should return true for config transaction discriminator', () => {
      const accountData = Buffer.alloc(100);
      accountData.set(
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG],
        0,
      );
      expect(isConfigTransaction(accountData)).to.be.true;
    });

    it('should return false for non-config transaction discriminator', () => {
      const accountData = Buffer.alloc(100);
      accountData.set(
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT],
        0,
      );
      expect(isConfigTransaction(accountData)).to.be.false;
    });
  });
});
