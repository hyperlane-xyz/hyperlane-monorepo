import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from 'vitest';

import {
  getScenariosDir,
  listScenarios,
  loadScenario,
  loadScenarioFile,
} from '../../src/ScenarioLoader.js';

describe('ScenarioLoader', () => {
  const originalScenariosDir = process.env['SCENARIOS_DIR'];
  let customDir: string | undefined;

  afterEach(() => {
    if (customDir) {
      fs.rmSync(customDir, { recursive: true, force: true });
      customDir = undefined;
    }
    if (originalScenariosDir === undefined) {
      delete process.env['SCENARIOS_DIR'];
    } else {
      process.env['SCENARIOS_DIR'] = originalScenariosDir;
    }
  });

  it('uses bundled package scenarios by default', () => {
    delete process.env['SCENARIOS_DIR'];

    const scenariosDir = getScenariosDir();
    expect(fs.existsSync(scenariosDir)).toBe(true);

    const scenarioNames = listScenarios();
    expect(scenarioNames.length).toBeGreaterThan(0);

    const file = loadScenarioFile(scenarioNames[0]);
    expect(file.name).toBe(scenarioNames[0]);
    expect(file.transfers.length).toBeGreaterThan(0);
  });

  it('supports SCENARIOS_DIR override', () => {
    customDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rebalancer-sim-scenarios-'),
    );

    const customScenario = {
      name: 'custom-one',
      description: 'Custom scenario',
      expectedBehavior: 'Loads from override dir',
      duration: 1000,
      chains: ['chain1', 'chain2'],
      transfers: [
        {
          id: 't1',
          timestamp: 0,
          origin: 'chain1',
          destination: 'chain2',
          amount: '1',
          user: '0x0000000000000000000000000000000000000001',
        },
      ],
      defaultInitialCollateral: '100',
      defaultTiming: {
        userTransferDeliveryDelay: 100,
        rebalancerPollingFrequency: 500,
        userTransferInterval: 100,
      },
      defaultBridgeConfig: {
        chain1: {
          chain2: { deliveryDelay: 100, failureRate: 0, deliveryJitter: 0 },
        },
        chain2: {
          chain1: { deliveryDelay: 100, failureRate: 0, deliveryJitter: 0 },
        },
      },
      defaultStrategyConfig: {
        type: 'minAmount' as const,
        chains: {
          chain1: {
            minAmount: { min: '1', target: '2' },
            bridgeLockTime: 1000,
          },
          chain2: {
            minAmount: { min: '1', target: '2' },
            bridgeLockTime: 1000,
          },
        },
      },
      expectations: {
        minCompletionRate: 1,
      },
    };

    fs.writeFileSync(
      path.join(customDir, 'custom-one.json'),
      JSON.stringify(customScenario, null, 2),
    );
    process.env['SCENARIOS_DIR'] = customDir;

    expect(getScenariosDir()).toBe(customDir);
    expect(listScenarios()).toEqual(['custom-one']);

    const loaded = loadScenario('custom-one');
    expect(loaded.name).toBe('custom-one');
    expect(loaded.transfers[0].amount).toBe(BigInt(1));
  });
});
