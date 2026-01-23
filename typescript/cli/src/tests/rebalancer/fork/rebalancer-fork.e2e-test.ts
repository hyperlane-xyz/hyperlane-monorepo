import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import { rmSync } from 'fs';
import { type ProcessPromise } from 'zx';

import {
  type RebalancerConfigFileInput,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
} from '@hyperlane-xyz/rebalancer';
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';

import { getContext } from '../../../context/context.js';
import { writeYamlOrJson } from '../../../utils/files.js';
import { hyperlaneWarpRebalancer } from '../../ethereum/commands/warp.js';
import {
  ANVIL_KEY,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
} from '../../ethereum/consts.js';

import {
  type ForkHarnessResult,
  MAINNET_CCTP_WARP_ROUTE_CONFIG,
  type SupportedChain,
  forkChainsForRebalancer,
  getWarpRouteUsdcBalance,
  setWarpRouteUsdcBalance,
  setupForkedChainsForRebalancer,
} from './rebalancer-fork-utils.js';

chai.use(chaiAsPromised);
chai.should();

// Skip these tests by default as they require mainnet RPC access
// Run with: REBALANCER_FORK_TEST=1 pnpm test:rebalancer:fork
const SKIP_TESTS = !process.env.REBALANCER_FORK_TEST;

describe('USDC Warp Route Rebalancer Fork Tests', async function () {
  // Forking 7 chains takes time
  this.timeout(5 * DEFAULT_E2E_TEST_TIMEOUT);

  const REBALANCER_CONFIG_PATH = `${TEMP_PATH}/rebalancer-fork-test-config.yaml`;
  const CHECK_FREQUENCY = 60000;

  // Test with subset of chains to reduce resource usage
  const TEST_CHAINS: SupportedChain[] = ['ethereum', 'arbitrum', 'base'];

  let harness: ForkHarnessResult;
  let rebalancerConfig: RebalancerConfigFileInput;

  before(async function () {
    if (SKIP_TESTS) {
      this.skip();
      return;
    }

    console.log('Setting up fork harness for rebalancer tests...');
    console.log('Forking chains:', TEST_CHAINS.join(', '));

    // Get context from CLI - use GitHub registry for mainnet chain metadata
    const context = await getContext({
      registryUris: [DEFAULT_GITHUB_REGISTRY],
      key: ANVIL_KEY,
    });

    // Fork chains
    harness = await forkChainsForRebalancer(context, TEST_CHAINS);

    // Setup mocks and permissions
    const rebalancerAddress = new ethers.Wallet(ANVIL_KEY).address;
    await setupForkedChainsForRebalancer(harness, rebalancerAddress);

    // Create base rebalancer config
    // Note: min/target values are in human-readable format (not atomic units)
    // toWei() is called internally to convert to atomic units
    rebalancerConfig = {
      warpRouteId: MAINNET_CCTP_WARP_ROUTE_CONFIG.warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
        chains: Object.fromEntries(
          TEST_CHAINS.map((chain) => [
            chain,
            {
              minAmount: {
                min: '5000', // 5000 USDC (human-readable, toWei converts to atomic)
                target: '10000', // 10000 USDC
                type: RebalancerMinAmountType.Absolute,
              },
              bridge: MAINNET_CCTP_WARP_ROUTE_CONFIG.chains[chain].warpRoute,
              bridgeLockTime: 1800,
              bridgeMinAcceptedAmount: '1000', // 1000 USDC
            },
          ]),
        ),
      },
    };

    console.log('Fork harness setup complete');
  });

  after(async function () {
    if (harness) {
      await harness.cleanup();
    }
    rmSync(REBALANCER_CONFIG_PATH, { force: true });
  });

  beforeEach(async function () {
    // Reset balances to known state before each test
    for (const chainName of TEST_CHAINS) {
      const fork = harness.forks.get(chainName);
      if (fork) {
        // Set initial balanced state: 10000 USDC each
        await setWarpRouteUsdcBalance(
          fork.provider,
          chainName,
          BigInt(10000 * 1e6),
        );
      }
    }
  });

  function startRebalancer(
    options: {
      checkFrequency?: number;
      withMetrics?: boolean;
      monitorOnly?: boolean;
      explorerUrl?: string;
      registryUrl?: string;
    } = {},
  ): ProcessPromise {
    const {
      checkFrequency = CHECK_FREQUENCY,
      withMetrics = false,
      monitorOnly = false,
      explorerUrl,
      registryUrl,
    } = options;

    return hyperlaneWarpRebalancer(
      checkFrequency,
      REBALANCER_CONFIG_PATH,
      withMetrics,
      monitorOnly,
      false, // manual
      undefined, // origin
      undefined, // destination
      undefined, // amount
      ANVIL_KEY,
      explorerUrl,
      registryUrl ? [registryUrl] : undefined,
    );
  }

  async function createMockExplorerServer(): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    const http = await import('http');
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { message_view: [] } }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address: any = server.address();
    const url = `http://127.0.0.1:${address.port}`;

    return {
      url,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  async function startRebalancerAndExpectLog(
    log: string | string[],
    options: {
      timeout?: number;
      checkFrequency?: number;
      monitorOnly?: boolean;
      explorerUrl?: string;
      registryUrl?: string;
    } = {},
  ): Promise<void> {
    const {
      timeout = 30000,
      checkFrequency,
      monitorOnly,
      explorerUrl,
      registryUrl,
    } = options;

    const rebalancer = startRebalancer({
      checkFrequency,
      monitorOnly,
      explorerUrl,
      registryUrl,
    });

    const expectedLogs = Array.isArray(log) ? [...log] : [log];

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout waiting for log: "${expectedLogs[0]}"`));
      }, timeout);

      rebalancer.catch((e) => {
        const lines = typeof e.lines === 'function' ? e.lines() : [];
        const combined = Array.isArray(lines) ? lines.join('\n') : String(e);

        while (expectedLogs.length && combined.includes(expectedLogs[0])) {
          expectedLogs.shift();
        }

        clearTimeout(timeoutId);
        if (!expectedLogs.length) {
          resolve();
        } else {
          reject(
            new Error(
              `Process failed before logging: "${expectedLogs[0]}" with error: ${combined.slice(-500)}`,
            ),
          );
        }
      });

      (async () => {
        for await (let chunk of rebalancer.stdout) {
          chunk = typeof chunk === 'string' ? chunk : chunk.toString();
          const lines = chunk.split('\n').filter(Boolean);

          for (const line of lines) {
            if (!expectedLogs.length) break;
            try {
              const logJson = JSON.parse(line);
              if (logJson.msg?.includes(expectedLogs[0])) {
                expectedLogs.shift();
              }
            } catch {
              if (line.includes(expectedLogs[0])) {
                expectedLogs.shift();
              }
            }
          }

          if (!expectedLogs.length) {
            resolve();
            break;
          }
        }
      })().catch(reject);
    }).finally(async () => {
      try {
        await rebalancer.kill('SIGINT');
      } catch {
        // Process may have already exited
      }
    });
  }

  describe('Balance manipulation', () => {
    it('should be able to set and read USDC balances', async function () {
      const ethereumFork = harness.forks.get('ethereum');
      if (!ethereumFork) throw new Error('Ethereum fork not found');

      // Set a specific balance
      const targetBalance = BigInt(50000 * 1e6); // 50000 USDC
      await setWarpRouteUsdcBalance(
        ethereumFork.provider,
        'ethereum',
        targetBalance,
      );

      // Read back and verify
      const actualBalance = await getWarpRouteUsdcBalance(
        ethereumFork.provider,
        'ethereum',
      );

      expect(actualBalance).to.equal(targetBalance);
    });

    it('should create imbalance between chains', async function () {
      const ethereumFork = harness.forks.get('ethereum');
      const arbitrumFork = harness.forks.get('arbitrum');

      if (!ethereumFork || !arbitrumFork) {
        throw new Error('Required forks not found');
      }

      // Create imbalance: high on ethereum, low on arbitrum
      await setWarpRouteUsdcBalance(
        ethereumFork.provider,
        'ethereum',
        BigInt(100000 * 1e6), // 100000 USDC
      );
      await setWarpRouteUsdcBalance(
        arbitrumFork.provider,
        'arbitrum',
        BigInt(1000 * 1e6), // 1000 USDC (below minAmount threshold)
      );

      const ethBalance = await getWarpRouteUsdcBalance(
        ethereumFork.provider,
        'ethereum',
      );
      const arbBalance = await getWarpRouteUsdcBalance(
        arbitrumFork.provider,
        'arbitrum',
      );

      expect(ethBalance > arbBalance).to.be.true;
      expect(arbBalance < BigInt(5000 * 1e6)).to.be.true; // Below minAmount
    });
  });

  describe('HTTP Registry', () => {
    it('should return metadata with forked RPC URLs', async function () {
      // Verify the HTTP registry returns the correct forked RPC URLs
      const response = await fetch(`${harness.registryUrl}/metadata`);
      expect(response.ok).to.be.true;

      const metadata: Record<string, { rpcUrls?: Array<{ http: string }> }> =
        await response.json();

      // Check that all forked chains have the correct RPC URLs
      for (const chainName of TEST_CHAINS) {
        const fork = harness.forks.get(chainName);
        expect(fork).to.not.be.undefined;

        console.log(
          `${chainName} metadata rpcUrls:`,
          metadata[chainName]?.rpcUrls,
        );
        console.log(`${chainName} expected endpoint:`, fork?.endpoint);

        expect(metadata[chainName]?.rpcUrls?.[0]?.http).to.equal(
          fork?.endpoint,
        );
      }
    });

    it('should verify CLI getContext uses HTTP registry metadata', async function () {
      // Test that getContext properly creates a MultiProvider with forked RPC URLs
      const testContext = await getContext({
        registryUris: [harness.registryUrl],
        key: ANVIL_KEY,
      });

      // Check that the MultiProvider has the forked RPC URLs
      for (const chainName of TEST_CHAINS) {
        const fork = harness.forks.get(chainName);
        const metadata = testContext.multiProvider.getChainMetadata(chainName);
        console.log(
          `${chainName} MultiProvider rpcUrls:`,
          metadata?.rpcUrls?.[0]?.http,
        );
        expect(metadata?.rpcUrls?.[0]?.http).to.equal(fork?.endpoint);
      }
    });
  });

  describe('Rebalancer detection', () => {
    it('should detect imbalance and find rebalancing routes', async function () {
      const mockServer = await createMockExplorerServer();

      try {
        // Create imbalance
        const ethereumFork = harness.forks.get('ethereum');
        const arbitrumFork = harness.forks.get('arbitrum');

        if (!ethereumFork || !arbitrumFork) {
          throw new Error('Required forks not found');
        }

        await setWarpRouteUsdcBalance(
          ethereumFork.provider,
          'ethereum',
          BigInt(100000 * 1e6),
        );
        await setWarpRouteUsdcBalance(
          arbitrumFork.provider,
          'arbitrum',
          BigInt(1000 * 1e6),
        );

        // Write config
        writeYamlOrJson(REBALANCER_CONFIG_PATH, rebalancerConfig);

        // Start rebalancer and wait for it to detect the imbalance
        await startRebalancerAndExpectLog('Found rebalancing routes', {
          explorerUrl: mockServer.url,
          registryUrl: harness.registryUrl,
          timeout: 60000,
        });
      } finally {
        await mockServer.close();
      }
    });

    it('should skip when no routes needed (balanced state)', async function () {
      const mockServer = await createMockExplorerServer();

      try {
        // Ensure balanced state (already set in beforeEach)
        for (const chainName of TEST_CHAINS) {
          const fork = harness.forks.get(chainName);
          if (fork) {
            await setWarpRouteUsdcBalance(
              fork.provider,
              chainName,
              BigInt(10000 * 1e6),
            );
          }
        }

        writeYamlOrJson(REBALANCER_CONFIG_PATH, rebalancerConfig);

        await startRebalancerAndExpectLog('No rebalancing needed', {
          explorerUrl: mockServer.url,
          registryUrl: harness.registryUrl,
          timeout: 60000,
        });
      } finally {
        await mockServer.close();
      }
    });
  });

  describe('Monitor mode', () => {
    it('should run in monitor-only mode without executing', async function () {
      const mockServer = await createMockExplorerServer();

      try {
        // Create imbalance
        const ethereumFork = harness.forks.get('ethereum');
        const arbitrumFork = harness.forks.get('arbitrum');

        if (!ethereumFork || !arbitrumFork) {
          throw new Error('Required forks not found');
        }

        await setWarpRouteUsdcBalance(
          ethereumFork.provider,
          'ethereum',
          BigInt(100000 * 1e6),
        );
        await setWarpRouteUsdcBalance(
          arbitrumFork.provider,
          'arbitrum',
          BigInt(1000 * 1e6),
        );

        writeYamlOrJson(REBALANCER_CONFIG_PATH, rebalancerConfig);

        await startRebalancerAndExpectLog('Found rebalancing routes', {
          explorerUrl: mockServer.url,
          registryUrl: harness.registryUrl,
          monitorOnly: true,
          timeout: 60000,
        });

        // Verify balances haven't changed (monitor only)
        const ethBalanceAfter = await getWarpRouteUsdcBalance(
          ethereumFork.provider,
          'ethereum',
        );
        const arbBalanceAfter = await getWarpRouteUsdcBalance(
          arbitrumFork.provider,
          'arbitrum',
        );

        expect(ethBalanceAfter).to.equal(BigInt(100000 * 1e6));
        expect(arbBalanceAfter).to.equal(BigInt(1000 * 1e6));
      } finally {
        await mockServer.close();
      }
    });
  });
});
