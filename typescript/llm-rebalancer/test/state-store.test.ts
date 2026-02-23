import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';

import { SqliteAdapter } from '../src/sql/SqliteAdapter.js';
import { StateStore } from '../src/state/StateStore.js';
import type { PlannedAction } from '../src/types.js';

describe('state store', () => {
  it('persists state and deduplicates by action fingerprint', async () => {
    const dbPath = join(tmpdir(), `llm-rebalancer-${Date.now()}.db`);
    const sql = new SqliteAdapter(dbPath);
    const store = new StateStore(sql);
    await store.initialize();

    const runId = await store.startRun({ test: true });

    const action: PlannedAction = {
      actionFingerprint: 'fp-1',
      executionType: 'inventory',
      routeId: 'MULTI/stableswap',
      origin: 'anvil2',
      destination: 'anvil3',
      sourceRouter: '0x1',
      destinationRouter: '0x2',
      amount: '1000',
      bridge: 'lifi',
      reason: 'test',
    };

    const first = await store.upsertPlannedAction(runId, action);
    const second = await store.upsertPlannedAction(runId, action);

    expect(first.actionId).to.equal(second.actionId);

    const prior = await store.getPriorContext();
    expect(prior.openActions).to.have.length(1);

    await store.recordActionAttempt(first.actionId, {
      actionFingerprint: action.actionFingerprint,
      success: true,
      txHash: '0xtx',
      messageId: '0xmsg',
    });

    await store.markReconciled(action.actionFingerprint);
    await store.finishRun(runId, 'success');
    await store.close();
    await rm(dbPath, { force: true });
  });
});
