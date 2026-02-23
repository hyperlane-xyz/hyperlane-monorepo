import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'chai';
import pino from 'pino';

import { SkillFirstLoop } from '../src/loop/SkillFirstLoop.js';
import { FakeRuntime } from '../src/runtime/FakeRuntime.js';
import { SqliteAdapter } from '../src/sql/SqliteAdapter.js';
import { StateStore } from '../src/state/StateStore.js';
import type { LlmRebalancerConfig, SkillProfile } from '../src/types.js';

describe('crash and resume', () => {
  it('resumes from SQL state without duplicating planned action records', async () => {
    const dbPath = join(tmpdir(), `llm-loop-resume-${Date.now()}.db`);
    const sql = new SqliteAdapter(dbPath);
    const store = new StateStore(sql);
    await store.initialize();

    const profile: SkillProfile = {
      observe: 'observe',
      inflightRpc: 'inflight-rpc',
      inflightExplorer: 'inflight-explorer',
      inflightHybrid: 'inflight-hybrid',
      executeMovable: 'execute-movable',
      executeInventoryLifi: 'execute-inventory-lifi',
      reconcile: 'reconcile',
      globalNetting: 'global-netting',
    };

    const config: LlmRebalancerConfig = {
      warpRouteIds: ['MULTI/stableswap'],
      registryUri: '/tmp/registry',
      llmProvider: 'codex',
      llmModel: 'gpt-5',
      intervalMs: 1000,
      db: { url: `sqlite://${dbPath}` },
      inflightMode: 'hybrid',
      skills: { profile },
      signerEnv: 'HYP_REBALANCER_KEY',
      inventorySignerEnv: 'HYP_INVENTORY_KEY',
      executionPaths: ['movableCollateral', 'inventory'],
      inventoryBridge: 'lifi',
      runtime: {
        type: 'pi-openclaw',
        command: 'openclaw',
        argsTemplate: [],
        timeoutMs: 1000,
      },
    };

    const plannedAction = {
      actionFingerprint: 'resume-fp',
      executionType: 'inventory' as const,
      routeId: 'MULTI/stableswap',
      origin: 'anvil2',
      destination: 'anvil3',
      sourceRouter: '0x1',
      destinationRouter: '0x2',
      amount: '1000',
      bridge: 'lifi' as const,
    };

    const failingRuntime = new FakeRuntime({
      [profile.observe]: () => ({ observedAt: Date.now(), routerBalances: [] }),
      [profile.inflightHybrid]: () => ({ messages: [] }),
      [profile.globalNetting]: () => ({ summary: 'plan', actions: [plannedAction] }),
      [profile.executeInventoryLifi]: () => {
        throw new Error('simulated crash during execution');
      },
      [profile.reconcile]: () => ({ deliveredActionFingerprints: [] }),
    });

    const loop1 = new SkillFirstLoop(
      config,
      profile,
      failingRuntime,
      store,
      pino({ level: 'silent' }),
    );

    let threw = false;
    try {
      await loop1.runCycle();
    } catch (error) {
      threw = true;
      expect(String(error)).to.include('simulated crash during execution');
    }
    expect(threw).to.equal(true);

    const succeedingRuntime = new FakeRuntime({
      [profile.observe]: () => ({ observedAt: Date.now(), routerBalances: [] }),
      [profile.inflightHybrid]: () => ({ messages: [] }),
      [profile.globalNetting]: () => ({ summary: 'plan', actions: [plannedAction] }),
      [profile.executeInventoryLifi]: () => ({
        success: true,
        txHash: '0xresume',
        messageId: '0xresume-msg',
      }),
      [profile.reconcile]: () => ({ deliveredActionFingerprints: ['resume-fp'] }),
    });

    const loop2 = new SkillFirstLoop(
      config,
      profile,
      succeedingRuntime,
      store,
      pino({ level: 'silent' }),
    );

    await loop2.runCycle();

    const actionRows = await sql.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM actions WHERE action_fingerprint = $1`,
      ['resume-fp'],
    );
    expect(Number(actionRows[0].count)).to.equal(1);

    const attemptRows = await sql.query<{ count: number }>(
      `SELECT COUNT(*) as count FROM action_attempts`,
      [],
    );
    expect(Number(attemptRows[0].count)).to.equal(2);

    await store.close();
    await rm(dbPath, { force: true });
  });
});
