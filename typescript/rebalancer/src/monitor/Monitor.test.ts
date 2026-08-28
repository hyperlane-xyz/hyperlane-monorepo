import { expect } from 'chai';
import { pino } from 'pino';

import type { WarpCore } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  MonitorEventType,
  MonitorPollingError,
} from '../interfaces/IMonitor.js';
import { Monitor } from './Monitor.js';

describe('Monitor inventory reads', () => {
  for (const failure of ['RPC timeout', 'missing token', 'missing signer']) {
    it(`emits a polling error without a false zero balance on ${failure}`, async () => {
      const token = {
        chainName: 'solanamainnet',
        protocol: ProtocolType.Sealevel,
        isHypToken: () => true,
        getHypAdapter: () => ({ getBridgedSupply: async () => 100n }),
        getAdapter: () => ({
          getBalance: async () => {
            throw new Error('RPC timeout');
          },
        }),
      };
      const warpCore = {
        tokens: failure === 'missing token' ? [] : [token],
        multiProvider: {
          getChainMetadata: () => ({ protocol: ProtocolType.Sealevel }),
        },
      } as unknown as WarpCore;
      const monitor = new Monitor(0, warpCore, pino({ level: 'silent' }), {
        chains: ['solanamainnet'],
        inventoryAddresses:
          failure === 'missing signer'
            ? {}
            : { [ProtocolType.Sealevel]: 'inventory-owner' },
      });
      const errors: Error[] = [];
      let balancesEmitted = 0;
      monitor.on(MonitorEventType.Error, (error) => {
        errors.push(error);
        void monitor.stop();
      });
      monitor.on(MonitorEventType.TokenInfo, () => {
        balancesEmitted++;
        void monitor.stop();
      });
      await monitor.start();
      expect(errors).to.have.length(1);
      expect(errors[0]).to.be.instanceOf(MonitorPollingError);
      expect(balancesEmitted).to.equal(0);
    });
  }

  it('emits a genuine zero inventory balance normally', async () => {
    const token = {
      chainName: 'solanamainnet',
      protocol: ProtocolType.Sealevel,
      isHypToken: () => true,
      getHypAdapter: () => ({ getBridgedSupply: async () => 100n }),
      getAdapter: () => ({ getBalance: async () => 0n }),
    };
    const warpCore = {
      tokens: [token],
      multiProvider: {
        getChainMetadata: () => ({ protocol: ProtocolType.Sealevel }),
      },
    } as unknown as WarpCore;
    const monitor = new Monitor(0, warpCore, pino({ level: 'silent' }), {
      chains: ['solanamainnet'],
      inventoryAddresses: { [ProtocolType.Sealevel]: 'inventory-owner' },
    });
    const errors: Error[] = [];
    let inventory: Record<string, bigint> | undefined;
    monitor.on(MonitorEventType.Error, (error) => {
      errors.push(error);
      void monitor.stop();
    });
    monitor.on(MonitorEventType.TokenInfo, (event) => {
      inventory = event.inventoryBalances;
      void monitor.stop();
    });
    await monitor.start();
    expect(errors).to.have.length(0);
    expect(inventory).to.deep.equal({ solanamainnet: 0n });
  });
});
