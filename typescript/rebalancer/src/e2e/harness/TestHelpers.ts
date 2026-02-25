import { BigNumber, providers } from 'ethers';

import type { RebalanceAction } from '../../tracking/types.js';
import type { MonitorEvent } from '../../interfaces/IMonitor.js';
import { MonitorEventType } from '../../interfaces/IMonitor.js';
import type { Monitor } from '../../monitor/Monitor.js';

import {
  DOMAIN_IDS,
  type NativeDeployedAddresses,
  TEST_CHAINS,
} from '../fixtures/routes.js';

export async function getFirstMonitorEvent(
  monitor: Monitor,
): Promise<MonitorEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Monitor event timeout'));
    }, 60_000);

    monitor.on(MonitorEventType.TokenInfo, (event: MonitorEvent) => {
      clearTimeout(timeout);
      void monitor.stop();
      resolve(event);
    });

    monitor.on(MonitorEventType.Error, (error: Error) => {
      clearTimeout(timeout);
      void monitor.stop();
      reject(error);
    });

    void monitor.start();
  });
}

export function chainFromDomain(domain: number): string {
  const found = Object.entries(DOMAIN_IDS).find(([, d]) => d === domain);
  if (!found) {
    throw new Error(`Unknown domain: ${domain}`);
  }
  return found[0];
}

export async function getRouterBalances(
  localProviders: Map<string, providers.JsonRpcProvider>,
  addresses: NativeDeployedAddresses,
): Promise<Record<string, BigNumber>> {
  const balances: Record<string, BigNumber> = {};
  for (const chain of TEST_CHAINS) {
    const provider = localProviders.get(chain)!;
    balances[chain] = await provider.getBalance(
      addresses.monitoredRoute[chain],
    );
  }
  return balances;
}

export interface ChainRoles {
  deficitChain: string;
  surplusChain: string;
  neutralChain?: string;
}

/**
 * Classify chains into deficit, surplus, and neutral based on a deposit action.
 *
 * For inventory deposits the execution direction is swapped: the action's
 * destination is the surplus chain (where the router pays out on delivery).
 */
export function classifyChains(
  deficitChain: string,
  depositAction: RebalanceAction,
): ChainRoles {
  const surplusChain = chainFromDomain(depositAction.destination);
  const neutralChain = TEST_CHAINS.find(
    (c) => c !== deficitChain && c !== surplusChain,
  );
  return { deficitChain, surplusChain, neutralChain };
}
