import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

import { createStateApi, type StateApiDeps, type StateApiConfig } from '../src/api/stateApi.js';

describe('State API', () => {
  let deps: StateApiDeps;
  let config: StateApiConfig;

  beforeEach(() => {
    deps = {
      getLatestBalances: vi.fn().mockReturnValue({
        ethereum: 400000000000n,
        base: 500000000000n,
      }),
      getChainNames: vi.fn().mockReturnValue(['ethereum', 'base', 'arbitrum']),
      actionTracker: {
        getInProgressTransfers: vi.fn().mockResolvedValue([
          {
            origin: 1,
            destination: 8453,
            amount: 50000000000n,
            status: 'in_progress',
            messageId: '0xabc',
            createdAt: 1711400000,
          },
        ]),
        getActiveRebalanceIntents: vi.fn().mockResolvedValue([
          {
            origin: 42161,
            destination: 1,
            amount: 30000000000n,
            fulfilledAmount: 0n,
            status: 'in_progress',
            strategyType: 'weighted',
            priority: 1,
          },
        ]),
      } as unknown as StateApiDeps['actionTracker'],
    };
    config = {
      logger: {
        child: () => ({ info: vi.fn(), error: vi.fn() }),
        info: vi.fn(),
        error: vi.fn(),
      } as any,
    };
  });

  it('GET /state returns full snapshot', async () => {
    const app = createStateApi(deps, config);
    const res = await request(app).get('/state');

    expect(res.status).toBe(200);
    expect(res.body.balances).toEqual({
      ethereum: '400000000000',
      base: '500000000000',
    });
    expect(res.body.chains).toEqual(['ethereum', 'base', 'arbitrum']);
    expect(res.body.transfers).toHaveLength(1);
    expect(res.body.transfers[0].amount).toBe('50000000000');
    expect(res.body.intents).toHaveLength(1);
    expect(res.body.intents[0].amount).toBe('30000000000');
    expect(res.body.timestamp).toBeDefined();
  });

  it('GET /balances returns balances only', async () => {
    const app = createStateApi(deps, config);
    const res = await request(app).get('/balances');

    expect(res.status).toBe(200);
    expect(res.body.balances.ethereum).toBe('400000000000');
    expect(res.body.transfers).toBeUndefined();
  });

  it('GET /balances returns 503 when no balances yet', async () => {
    deps.getLatestBalances = vi.fn().mockReturnValue(null);
    const app = createStateApi(deps, config);
    const res = await request(app).get('/balances');

    expect(res.status).toBe(503);
  });

  it('GET /health returns ok when balances available', async () => {
    const app = createStateApi(deps, config);
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.hasBalances).toBe(true);
  });

  it('GET /health returns waiting when no balances', async () => {
    deps.getLatestBalances = vi.fn().mockReturnValue(null);
    const app = createStateApi(deps, config);
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('waiting');
  });

  it('GET /state handles actionTracker errors gracefully', async () => {
    (deps.actionTracker.getInProgressTransfers as any).mockRejectedValue(
      new Error('tracker unavailable'),
    );
    const app = createStateApi(deps, config);
    const res = await request(app).get('/state');

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});
