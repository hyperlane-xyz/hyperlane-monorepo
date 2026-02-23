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

describe('skill-first loop', () => {
  it('reads prior SQL context before planning and executes plan', async () => {
    const dbPath = join(tmpdir(), `llm-loop-${Date.now()}.db`);
    const sql = new SqliteAdapter(dbPath);
    const store = new StateStore(sql);
    await store.initialize();

    const seededRun = await store.startRun({ seeded: true });
    await store.upsertPlannedAction(seededRun, {
      actionFingerprint: 'seed-fp',
      executionType: 'inventory',
      routeId: 'MULTI/stableswap',
      origin: 'anvil2',
      destination: 'anvil3',
      sourceRouter: '0xseed1',
      destinationRouter: '0xseed2',
      amount: '1',
      bridge: 'lifi',
      reason: 'seed',
    });
    await store.finishRun(seededRun, 'success');

    let plannerSawPriorContext = false;

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

    const runtime = new FakeRuntime({
      [profile.observe]: () => ({
        observedAt: Date.now(),
        routerBalances: [
          {
            routeId: 'MULTI/stableswap',
            chain: 'anvil2',
            symbol: 'USDC',
            router: '0xabc',
            collateral: '1000',
            inventory: '100',
          },
        ],
      }),
      [profile.inflightHybrid]: () => ({ messages: [] }),
      [profile.globalNetting]: (input) => {
        const typed = input as any;
        plannerSawPriorContext =
          typed.context.priorContext.openActions.length > 0;
        return {
          summary: 'one action',
          actions: [
            {
              actionFingerprint: 'new-fp',
              executionType: 'inventory',
              routeId: 'MULTI/stableswap',
              origin: 'anvil2',
              destination: 'anvil3',
              sourceRouter: '0x1',
              destinationRouter: '0x2',
              amount: '1000',
              bridge: 'lifi',
            },
          ],
        };
      },
      [profile.executeInventoryLifi]: () => ({
        success: true,
        txHash: '0xtx',
        messageId: '0xmsg',
      }),
      [profile.reconcile]: () => ({ deliveredActionFingerprints: ['new-fp'] }),
    });

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

    const loop = new SkillFirstLoop(
      config,
      profile,
      runtime,
      store,
      pino({ level: 'silent' }),
    );

    await loop.runCycle();

    expect(plannerSawPriorContext).to.equal(true);

    await store.close();
    await rm(dbPath, { force: true });
  });
});
