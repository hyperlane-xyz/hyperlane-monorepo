import { expect } from 'chai';
import { Registry } from 'prom-client';
import sinon from 'sinon';

import type { RebalanceAction } from '../tracking/types.js';
import {
  ActionHoldReason,
  getActionHoldReason,
} from '../tracking/actionDiagnostics.js';
import { registerActionMetrics } from './ActionMetrics.js';

const action: RebalanceAction = {
  id: 'not-a-metric-label',
  intentId: 'also-not-a-label',
  origin: 1,
  destination: 2,
  amount: 100n,
  status: 'in_progress',
  type: 'inventory_movement',
  createdAt: 1_000,
  updatedAt: 1_000,
  submissionState: 'unknown',
};

describe('local action metrics', () => {
  afterEach(() => sinon.restore());

  it('advances age on scrapes without external synchronization and clears resolved groups', async () => {
    const clock = sinon.useFakeTimers({ now: 3_601_000 });
    const registry = new Registry();
    let actions = [action];
    const read = sinon.stub().callsFake(async () => actions);
    registerActionMetrics(registry, 'TEST/route', read);
    const first = await registry.metrics();
    expect(first).to.include('hold_reason="source_unknown"} 3600');
    expect(first).to.include('hyperlane_rebalancer_inflight_actions');
    expect(first).not.to.include(action.id);
    expect(first).not.to.include(action.intentId);
    clock.tick(3_600_000);
    expect(await registry.metrics()).to.include(
      'hold_reason="source_unknown"} 7200',
    );
    actions = [];
    const resolved = await registry.metrics();
    expect(resolved).not.to.include('} 7200');
    expect(resolved).to.include('hold_reason="source_unknown"} 0');
    expect(action.status).to.equal('in_progress');
  });

  it('uses finite held reasons without turning bridge failures into releases', () => {
    expect(getActionHoldReason({ ...action, pendingApproval: {} })).to.equal(
      ActionHoldReason.ApprovalPending,
    );
    expect(
      getActionHoldReason({ ...action, lastBridgeStatus: 'failed' }),
    ).to.equal(ActionHoldReason.BridgeFailed);
    expect(
      getActionHoldReason({ ...action, lastBridgeStatus: 'not_found' }),
    ).to.equal(ActionHoldReason.BridgeNotFound);
    expect(
      getActionHoldReason({ ...action, submissionState: 'not_submitted' }),
    ).to.equal(ActionHoldReason.SourcePending);
    expect(getActionHoldReason({ ...action, messageId: 'message' })).to.equal(
      ActionHoldReason.SettlementPending,
    );
  });

  it('does not report zero reservations when local state cannot be read', async () => {
    const registry = new Registry();
    registerActionMetrics(registry, 'TEST/route', async () => {
      throw new Error('local store unavailable');
    });
    let error: unknown;
    try {
      await registry.metrics();
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.include('local store unavailable');
  });
});
