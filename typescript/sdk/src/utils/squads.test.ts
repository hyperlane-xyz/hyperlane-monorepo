import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  SQUADS_ACCOUNT_DISCRIMINATORS,
  SquadTxStatus,
  SquadsAccountType,
  SquadsPermission,
  SquadsProposalStatus,
  decodePermissions,
  getSquadTxStatus,
  isConfigTransaction,
  isVaultTransaction,
  parseSquadProposal,
} from './squads.js';

describe('squads parsing functions', () => {
  describe('parseSquadProposal', () => {
    it('should parse proposal with draft status', () => {
      const proposal = {
        status: { __kind: 'Draft' },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex: 0,
      };

      const parsed = parseSquadProposal(proposal);

      expect(parsed.status).to.equal('Draft');
      expect(parsed.approvals).to.equal(0);
      expect(parsed.rejections).to.equal(0);
      expect(parsed.cancellations).to.equal(0);
      expect(parsed.transactionIndex).to.equal(0);
    });

    it('should parse proposal with approvals and rejections', () => {
      const proposal = {
        status: { __kind: 'Active' },
        approved: [{ __kind: 'Approved' }, { __kind: 'Approved' }],
        rejected: [{ __kind: 'Rejected' }],
        cancelled: [],
        transactionIndex: 5,
      };

      const parsed = parseSquadProposal(proposal);

      expect(parsed.status).to.equal('Active');
      expect(parsed.approvals).to.equal(2);
      expect(parsed.rejections).to.equal(1);
      expect(parsed.cancellations).to.equal(0);
      expect(parsed.transactionIndex).to.equal(5);
    });

    it('should parse proposal with all vote types', () => {
      const proposal = {
        status: { __kind: 'Approved' },
        approved: [
          { __kind: 'Approved' },
          { __kind: 'Approved' },
          { __kind: 'Approved' },
        ],
        rejected: [{ __kind: 'Rejected' }],
        cancelled: [{ __kind: 'Cancelled' }],
        transactionIndex: 10,
      };

      const parsed = parseSquadProposal(proposal);

      expect(parsed.status).to.equal('Approved');
      expect(parsed.approvals).to.equal(3);
      expect(parsed.rejections).to.equal(1);
      expect(parsed.cancellations).to.equal(1);
      expect(parsed.transactionIndex).to.equal(10);
    });

    it('should handle bigint transaction index', () => {
      const proposal = {
        status: { __kind: 'Executed' },
        approved: [],
        rejected: [],
        cancelled: [],
        transactionIndex: BigInt(999),
      };

      const parsed = parseSquadProposal(proposal);

      expect(parsed.transactionIndex).to.equal(999);
      expect(typeof parsed.transactionIndex).to.equal('number');
    });
  });

  describe('decodePermissions', () => {
    it('should decode proposer permission', () => {
      const result = decodePermissions(SquadsPermission.PROPOSER);
      expect(result).to.equal('Proposer');
    });

    it('should decode voter permission', () => {
      const result = decodePermissions(SquadsPermission.VOTER);
      expect(result).to.equal('Voter');
    });

    it('should decode executor permission', () => {
      const result = decodePermissions(SquadsPermission.EXECUTOR);
      expect(result).to.equal('Executor');
    });

    it('should decode all permissions', () => {
      const result = decodePermissions(SquadsPermission.ALL_PERMISSIONS);
      expect(result).to.equal('Proposer, Voter, Executor');
    });

    it('should decode proposer and voter permissions', () => {
      const mask = SquadsPermission.PROPOSER | SquadsPermission.VOTER;
      const result = decodePermissions(mask);
      expect(result).to.equal('Proposer, Voter');
    });

    it('should decode voter and executor permissions', () => {
      const mask = SquadsPermission.VOTER | SquadsPermission.EXECUTOR;
      const result = decodePermissions(mask);
      expect(result).to.equal('Voter, Executor');
    });

    it('should return none for zero mask', () => {
      const result = decodePermissions(0);
      expect(result).to.equal('None');
    });

    it('should handle numeric mask values', () => {
      const result = decodePermissions(7);
      expect(result).to.equal('Proposer, Voter, Executor');
    });
  });

  describe('isVaultTransaction', () => {
    it('should identify vault transaction', () => {
      const vaultDiscriminator =
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT];
      const accountData = Buffer.concat([
        Buffer.from(vaultDiscriminator),
        Buffer.alloc(100),
      ]);

      const result = isVaultTransaction(accountData);
      expect(result).to.be.true;
    });

    it('should reject config transaction as vault', () => {
      const configDiscriminator =
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG];
      const accountData = Buffer.concat([
        Buffer.from(configDiscriminator),
        Buffer.alloc(100),
      ]);

      const result = isVaultTransaction(accountData);
      expect(result).to.be.false;
    });

    it('should reject invalid discriminator', () => {
      const invalidDiscriminator = Buffer.alloc(8);
      const accountData = Buffer.concat([
        invalidDiscriminator,
        Buffer.alloc(100),
      ]);

      const result = isVaultTransaction(accountData);
      expect(result).to.be.false;
    });

    it('should handle minimal buffer size', () => {
      const vaultDiscriminator =
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT];
      const accountData = Buffer.from(vaultDiscriminator);

      const result = isVaultTransaction(accountData);
      expect(result).to.be.true;
    });
  });

  describe('isConfigTransaction', () => {
    it('should identify config transaction', () => {
      const configDiscriminator =
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG];
      const accountData = Buffer.concat([
        Buffer.from(configDiscriminator),
        Buffer.alloc(100),
      ]);

      const result = isConfigTransaction(accountData);
      expect(result).to.be.true;
    });

    it('should reject vault transaction as config', () => {
      const vaultDiscriminator =
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.VAULT];
      const accountData = Buffer.concat([
        Buffer.from(vaultDiscriminator),
        Buffer.alloc(100),
      ]);

      const result = isConfigTransaction(accountData);
      expect(result).to.be.false;
    });

    it('should reject invalid discriminator', () => {
      const invalidDiscriminator = Buffer.alloc(8);
      const accountData = Buffer.concat([
        invalidDiscriminator,
        Buffer.alloc(100),
      ]);

      const result = isConfigTransaction(accountData);
      expect(result).to.be.false;
    });

    it('should handle minimal buffer size', () => {
      const configDiscriminator =
        SQUADS_ACCOUNT_DISCRIMINATORS[SquadsAccountType.CONFIG];
      const accountData = Buffer.from(configDiscriminator);

      const result = isConfigTransaction(accountData);
      expect(result).to.be.true;
    });
  });

  describe('getSquadTxStatus', () => {
    it('should return draft status', () => {
      const result = getSquadTxStatus(SquadsProposalStatus.Draft, 0, 2, 15, 10);
      expect(result).to.equal(SquadTxStatus.DRAFT);
    });

    it('should return active status when below threshold', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Active,
        1,
        3,
        15,
        10,
      );
      expect(result).to.equal(SquadTxStatus.ACTIVE);
    });

    it('should return one away status when one approval needed', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Active,
        2,
        3,
        15,
        10,
      );
      expect(result).to.equal(SquadTxStatus.ONE_AWAY);
    });

    it('should return approved status when threshold met', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Active,
        3,
        3,
        15,
        10,
      );
      expect(result).to.equal(SquadTxStatus.APPROVED);
    });

    it('should return approved status for approved proposal', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Approved,
        3,
        3,
        15,
        10,
      );
      expect(result).to.equal(SquadTxStatus.APPROVED);
    });

    it('should return rejected status', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Rejected,
        1,
        3,
        15,
        10,
      );
      expect(result).to.equal(SquadTxStatus.REJECTED);
    });

    it('should return executing status', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Executing,
        3,
        3,
        15,
        10,
      );
      expect(result).to.equal(SquadTxStatus.EXECUTING);
    });

    it('should return executed status', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Executed,
        3,
        3,
        15,
        10,
      );
      expect(result).to.equal(SquadTxStatus.EXECUTED);
    });

    it('should return cancelled status', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Cancelled,
        0,
        3,
        15,
        10,
      );
      expect(result).to.equal(SquadTxStatus.CANCELLED);
    });

    it('should return stale status for old transaction', () => {
      const result = getSquadTxStatus(SquadsProposalStatus.Active, 1, 3, 5, 10);
      expect(result).to.equal(SquadTxStatus.STALE);
    });

    it('should not return stale for executed transaction', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Executed,
        3,
        3,
        5,
        10,
      );
      expect(result).to.equal(SquadTxStatus.EXECUTED);
    });

    it('should handle edge case: transaction at stale boundary', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Active,
        1,
        3,
        10,
        10,
      );
      expect(result).to.equal(SquadTxStatus.ACTIVE);
    });

    it('should handle zero threshold', () => {
      const result = getSquadTxStatus(
        SquadsProposalStatus.Active,
        0,
        0,
        15,
        10,
      );
      expect(result).to.equal(SquadTxStatus.APPROVED);
    });
  });
});
