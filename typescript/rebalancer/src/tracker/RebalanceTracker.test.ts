import { expect } from 'chai';
import { pino } from 'pino';

import { RebalanceTracker } from './RebalanceTracker.js';

const testLogger = pino({ level: 'silent' });

const chain1 = 'chain1';
const chain2 = 'chain2';
const chain3 = 'chain3';

describe('RebalanceTracker', () => {
  let tracker: RebalanceTracker;

  beforeEach(() => {
    tracker = new RebalanceTracker(testLogger);
  });

  describe('createRebalance', () => {
    it('should create a new rebalance', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      expect(rebalance).to.not.be.null;
      expect(rebalance!.origin).to.equal(chain1);
      expect(rebalance!.destination).to.equal(chain2);
      expect(rebalance!.amount).to.equal(100n);
      expect(rebalance!.status).to.equal('not_started');
    });

    it('should return null if similar rebalance already exists', () => {
      const first = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });
      expect(first).to.not.be.null;

      const second = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 200n,
      });
      expect(second).to.be.null;
    });

    it('should allow rebalances to different destinations', () => {
      const first = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });
      const second = tracker.createRebalance({
        origin: chain1,
        destination: chain3,
        amount: 100n,
      });

      expect(first).to.not.be.null;
      expect(second).to.not.be.null;
    });
  });

  describe('findPendingRebalance', () => {
    it('should find pending rebalance', () => {
      const created = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      const found = tracker.findPendingRebalance(chain1, chain2);
      expect(found).to.deep.equal(created);
    });

    it('should not find completed rebalance', () => {
      const created = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      tracker.updateRebalanceStatus(created!.id, 'complete');

      const found = tracker.findPendingRebalance(chain1, chain2);
      expect(found).to.be.undefined;
    });
  });

  describe('updateRebalanceStatus', () => {
    it('should update status', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      tracker.updateRebalanceStatus(rebalance!.id, 'in_progress');

      const updated = tracker.getRebalance(rebalance!.id);
      expect(updated!.status).to.equal('in_progress');
    });
  });

  describe('cancelRebalance', () => {
    it('should cancel not_started rebalance', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      const result = tracker.cancelRebalance(rebalance!.id);
      expect(result).to.be.true;

      const cancelled = tracker.getRebalance(rebalance!.id);
      expect(cancelled!.status).to.equal('cancelled');
    });

    it('should not cancel completed rebalance', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      tracker.updateRebalanceStatus(rebalance!.id, 'complete');

      const result = tracker.cancelRebalance(rebalance!.id);
      expect(result).to.be.false;
    });
  });

  describe('createExecution', () => {
    it('should create execution for rebalance', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      const execution = tracker.createExecution({
        rebalanceId: rebalance!.id,
        type: 'rebalance_message',
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      expect(execution.rebalanceId).to.equal(rebalance!.id);
      expect(execution.type).to.equal('rebalance_message');
      expect(execution.status).to.equal('not_started');
    });

    it('should mark rebalance as in_progress when first execution created', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      tracker.createExecution({
        rebalanceId: rebalance!.id,
        type: 'rebalance_message',
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      const updated = tracker.getRebalance(rebalance!.id);
      expect(updated!.status).to.equal('in_progress');
    });

    it('should throw if rebalance not found', () => {
      expect(() =>
        tracker.createExecution({
          rebalanceId: 'non-existent',
          type: 'rebalance_message',
          origin: chain1,
          destination: chain2,
          amount: 100n,
        }),
      ).to.throw('Rebalance non-existent not found');
    });
  });

  describe('getExecutionsForRebalance', () => {
    it('should return all executions for rebalance', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      tracker.createExecution({
        rebalanceId: rebalance!.id,
        type: 'inventory_movement',
        origin: chain3,
        destination: chain1,
        amount: 50n,
      });

      tracker.createExecution({
        rebalanceId: rebalance!.id,
        type: 'rebalance_message',
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      const executions = tracker.getExecutionsForRebalance(rebalance!.id);
      expect(executions).to.have.lengthOf(2);
    });
  });

  describe('updateExecutionStatus', () => {
    it('should mark rebalance complete when all executions complete', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      const execution = tracker.createExecution({
        rebalanceId: rebalance!.id,
        type: 'rebalance_message',
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      tracker.updateExecutionStatus(execution.id, 'complete');

      const updated = tracker.getRebalance(rebalance!.id);
      expect(updated!.status).to.equal('complete');
    });
  });

  describe('getPendingRebalances', () => {
    it('should return only pending rebalances', () => {
      const r1 = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });
      const r2 = tracker.createRebalance({
        origin: chain2,
        destination: chain3,
        amount: 100n,
      });

      tracker.updateRebalanceStatus(r1!.id, 'complete');

      const pending = tracker.getPendingRebalances();
      expect(pending).to.have.lengthOf(1);
      expect(pending[0].id).to.equal(r2!.id);
    });
  });

  describe('getRebalanceContext', () => {
    it('should return context with pending items', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      tracker.createExecution({
        rebalanceId: rebalance!.id,
        type: 'rebalance_message',
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      const context = tracker.getRebalanceContext();
      expect(context.pendingRebalances).to.have.lengthOf(1);
      expect(context.pendingExecutions).to.have.lengthOf(1);
    });
  });

  describe('cleanup', () => {
    it('should remove old completed rebalances', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      tracker.updateRebalanceStatus(rebalance!.id, 'complete');

      // Force updatedAt to be old
      const r = tracker.getRebalance(rebalance!.id);
      (r as any).updatedAt = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago

      tracker.cleanup(24 * 60 * 60 * 1000); // 24 hour max age

      expect(tracker.getRebalance(rebalance!.id)).to.be.undefined;
    });

    it('should not remove recent completed rebalances', () => {
      const rebalance = tracker.createRebalance({
        origin: chain1,
        destination: chain2,
        amount: 100n,
      });

      tracker.updateRebalanceStatus(rebalance!.id, 'complete');

      tracker.cleanup(24 * 60 * 60 * 1000);

      expect(tracker.getRebalance(rebalance!.id)).to.not.be.undefined;
    });
  });
});
