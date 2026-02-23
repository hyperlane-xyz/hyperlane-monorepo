/**
 * MULTI-ASSET SIMULATION TEST SUITE
 * ==================================
 *
 * Tests multi-collateral (cross-asset) scenarios using MultiCollateral contracts.
 * Covers: cross-asset transfers, same-chain swaps, mixed traffic, and
 * ProductionRebalancer multi-asset rebalancing.
 *
 * Uses deployMultiAssetSimulation() instead of deployMultiDomainSimulation().
 */
import { ethers } from 'ethers';
import { expect } from 'chai';

import { resolveChainName } from '@hyperlane-xyz/rebalancer';

import {
  cleanupProductionRebalancer,
  deployMultiAssetSimulation,
  getWarpTokenBalance,
  loadScenario,
  loadScenarioFile,
  ProductionRebalancerRunner,
  SimulationEngine,
} from '../../src/index.js';
import { NoOpRebalancer } from '../../src/runners/NoOpRebalancer.js';
import {
  ANVIL_DEPLOYER_KEY,
  type AssetDefinition,
  type ChainStrategyConfig,
  type DeployedDomain,
  type MultiAssetDeploymentOptions,
  type MultiDomainDeploymentResult,
} from '../../src/types.js';
import { setupAnvilTestSuite } from '../utils/anvil.js';

/** Resolve bridge address for a strategy key. For "SYMBOL|chain" keys, uses per-asset bridge. */
function resolveBridge(
  deployment: MultiDomainDeploymentResult,
  key: string,
): string {
  const chainName = resolveChainName(key);
  const domain: DeployedDomain | undefined = deployment.domains[chainName];
  if (!domain) return ethers.constants.AddressZero;
  const pipeIdx = key.indexOf('|');
  if (pipeIdx >= 0 && domain.assets) {
    const symbol = key.slice(0, pipeIdx);
    const asset = domain.assets[symbol];
    if (asset?.bridge) return asset.bridge;
  }
  return domain.bridge;
}

describe('Multi-Asset Simulation', function () {
  const anvil = setupAnvilTestSuite(this);

  const ASSETS: AssetDefinition[] = [
    { symbol: 'USDC', decimals: 18 },
    { symbol: 'USDT', decimals: 18 },
  ];

  async function deployMultiAsset(rpc: string, chainCount: number) {
    const chains = Array.from({ length: chainCount }, (_, i) => ({
      chainName: `chain${i + 1}`,
      domainId: 1000 + i * 1000,
    }));

    const options: MultiAssetDeploymentOptions = {
      anvilRpc: rpc,
      deployerKey: ANVIL_DEPLOYER_KEY,
      chains,
      initialCollateralBalance: BigInt('100000000000000000000'), // 100 tokens
      assets: ASSETS,
    };

    return deployMultiAssetSimulation(options);
  }

  // ============================================================================
  // DEPLOYMENT TESTS
  // ============================================================================

  it('deploys multi-asset contracts correctly', async function () {
    const deployment = await deployMultiAsset(anvil.rpc, 2);

    // Verify domains
    expect(Object.keys(deployment.domains)).to.have.lengthOf(2);

    // Verify assets on each domain
    for (const [, domain] of Object.entries(deployment.domains)) {
      expect(domain.assets).to.not.be.undefined;
      expect(Object.keys(domain.assets!)).to.have.lengthOf(2);
      expect(domain.assets!['USDC']).to.not.be.undefined;
      expect(domain.assets!['USDT']).to.not.be.undefined;

      // Verify each asset has distinct addresses
      expect(domain.assets!['USDC'].warpToken).to.not.equal(
        domain.assets!['USDT'].warpToken,
      );
      expect(domain.assets!['USDC'].collateralToken).to.not.equal(
        domain.assets!['USDT'].collateralToken,
      );

      // Primary warp token should be first asset
      expect(domain.warpToken).to.equal(domain.assets!['USDC'].warpToken);
    }

    // Verify warp token balances
    const provider = new ethers.providers.JsonRpcProvider(anvil.rpc);
    for (const domain of Object.values(deployment.domains)) {
      for (const asset of Object.values(domain.assets!)) {
        const balance = await getWarpTokenBalance(
          provider,
          asset.warpToken,
          asset.collateralToken,
        );
        expect(balance).to.equal(BigInt('100000000000000000000'));
      }
    }
    provider.removeAllListeners();
    provider.polling = false;
  });

  // ============================================================================
  // SAME-CHAIN SWAP TEST
  // ============================================================================

  it('same-chain-swap: instant cross-asset swaps via direct handle()', async function () {
    this.timeout(60000);

    const file = loadScenarioFile('same-chain-swap');
    const scenario = loadScenario('same-chain-swap');

    const deployment = await deployMultiAsset(anvil.rpc, 1);

    const rebalancer = new NoOpRebalancer();

    // Build strategy config (no bridges needed for same-chain)
    const strategyConfig: {
      type: 'weighted' | 'minAmount' | 'collateralDeficit';
      chains: Record<string, ChainStrategyConfig>;
    } = {
      type: file.defaultStrategyConfig.type,
      chains: {},
    };
    for (const [key, chainConfig] of Object.entries(
      file.defaultStrategyConfig.chains,
    )) {
      // For multi-asset, key is "SYMBOL|chain" — extract chain name for bridge
      strategyConfig.chains[key] = {
        ...chainConfig,
        bridge: resolveBridge(deployment, key),
      };
    }

    const engine = new SimulationEngine(deployment);
    const result = await engine.runSimulation(
      scenario,
      rebalancer,
      file.defaultBridgeConfig,
      file.defaultTiming,
      strategyConfig,
    );

    console.log(
      `  Same-chain swap: ${result.kpis.completedTransfers}/${result.kpis.totalTransfers} completed`,
    );

    // All same-chain swaps should complete instantly
    expect(result.kpis.completionRate).to.equal(
      1.0,
      'All same-chain swaps should complete',
    );
    expect(result.kpis.totalRebalances).to.equal(
      0,
      'No rebalancing needed for same-chain swaps',
    );
  });

  // ============================================================================
  // CROSS-ASSET DRAIN TEST
  // ============================================================================

  it('cross-asset-drain: cross-chain USDC→USDT transfers', async function () {
    this.timeout(60000);

    const file = loadScenarioFile('cross-asset-drain');
    const scenario = loadScenario('cross-asset-drain');

    const deployment = await deployMultiAsset(anvil.rpc, 2);

    const rebalancer = new NoOpRebalancer();

    const strategyConfig: {
      type: 'weighted' | 'minAmount' | 'collateralDeficit';
      chains: Record<string, ChainStrategyConfig>;
    } = {
      type: file.defaultStrategyConfig.type,
      chains: {},
    };
    for (const [key, chainConfig] of Object.entries(
      file.defaultStrategyConfig.chains,
    )) {
      strategyConfig.chains[key] = {
        ...chainConfig,
        bridge: resolveBridge(deployment, key),
      };
    }

    const engine = new SimulationEngine(deployment);
    const result = await engine.runSimulation(
      scenario,
      rebalancer,
      file.defaultBridgeConfig,
      file.defaultTiming,
      strategyConfig,
    );

    console.log(
      `  Cross-asset drain (noop): ${result.kpis.completedTransfers}/${result.kpis.totalTransfers} completed`,
    );

    // With NoOp rebalancer, USDT on chain2 will eventually be drained
    // Some transfers should still succeed before drain
    expect(result.kpis.totalTransfers).to.be.greaterThan(0);
  });

  // ============================================================================
  // CROSS-CHAIN MIXED TEST
  // ============================================================================

  it('cross-chain-mixed: mixed same-asset and cross-asset traffic', async function () {
    this.timeout(60000);

    const file = loadScenarioFile('cross-chain-mixed');
    const scenario = loadScenario('cross-chain-mixed');

    const deployment = await deployMultiAsset(anvil.rpc, 3);

    const rebalancer = new NoOpRebalancer();

    const strategyConfig: {
      type: 'weighted' | 'minAmount' | 'collateralDeficit';
      chains: Record<string, ChainStrategyConfig>;
    } = {
      type: file.defaultStrategyConfig.type,
      chains: {},
    };
    for (const [key, chainConfig] of Object.entries(
      file.defaultStrategyConfig.chains,
    )) {
      strategyConfig.chains[key] = {
        ...chainConfig,
        bridge: resolveBridge(deployment, key),
      };
    }

    const engine = new SimulationEngine(deployment);
    const result = await engine.runSimulation(
      scenario,
      rebalancer,
      file.defaultBridgeConfig,
      file.defaultTiming,
      strategyConfig,
    );

    console.log(
      `  Mixed traffic (noop): ${result.kpis.completedTransfers}/${result.kpis.totalTransfers} completed`,
    );

    // Mixed traffic with noop — some should succeed
    expect(result.kpis.totalTransfers).to.be.greaterThan(0);
  });

  // ============================================================================
  // PRODUCTION REBALANCER MULTI-ASSET TEST
  // ============================================================================

  it('multi-asset-rebalance: ProductionRebalancer rebalances USDT across chains', async function () {
    this.timeout(120000);

    const file = loadScenarioFile('multi-asset-rebalance');
    const scenario = loadScenario('multi-asset-rebalance');

    const deployment = await deployMultiAsset(anvil.rpc, 2);

    const rebalancer = new ProductionRebalancerRunner();

    const strategyConfig: {
      type: 'weighted' | 'minAmount' | 'collateralDeficit';
      chains: Record<string, ChainStrategyConfig>;
    } = {
      type: file.defaultStrategyConfig.type,
      chains: {},
    };
    for (const [key, chainConfig] of Object.entries(
      file.defaultStrategyConfig.chains,
    )) {
      strategyConfig.chains[key] = {
        ...chainConfig,
        bridge: resolveBridge(deployment, key),
      };
    }

    const engine = new SimulationEngine(deployment);
    const result = await engine.runSimulation(
      scenario,
      rebalancer,
      file.defaultBridgeConfig,
      file.defaultTiming,
      strategyConfig,
    );

    await cleanupProductionRebalancer();

    console.log(
      `  Multi-asset rebalance (production): ${result.kpis.completedTransfers}/${result.kpis.totalTransfers} completed`,
    );
    console.log(`  Rebalances: ${result.kpis.totalRebalances}`);

    // ProductionRebalancer should detect the imbalance and rebalance
    expect(result.kpis.totalRebalances).to.be.greaterThan(
      0,
      'ProductionRebalancer should trigger rebalancing for cross-asset drain',
    );
    // With rebalancing, completion rate should be high
    expect(result.kpis.completionRate).to.be.greaterThanOrEqual(
      0.5,
      'At least 50% of transfers should complete with rebalancing',
    );
  });
});
