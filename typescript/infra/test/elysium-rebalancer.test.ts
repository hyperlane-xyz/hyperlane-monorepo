import { expect } from 'chai';
import path from 'path';

import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerStrategyOptions,
} from '@hyperlane-xyz/rebalancer';
import { assert } from '@hyperlane-xyz/utils';

import { readRebalancerConfig } from '../src/rebalancer/config.js';
import { getInfraPath } from '../src/utils/utils.js';

const configPath = path.join(
  getInfraPath(),
  'config/environments/mainnet3/rebalancer/USDC/eclipsemainnet-config.yaml',
);

describe('Elysium USDC inventory policy', () => {
  it('persists monitor-only mode for local validation', () => {
    const { deployment } = readRebalancerConfig(configPath);
    expect(deployment.monitorOnly).to.equal(true);
  });

  it('uses the agreed allocation without replacing existing inventory providers', () => {
    const { config } = readRebalancerConfig(configPath);
    const strategy = config.strategy[0];
    assert(
      strategy?.rebalanceStrategy === RebalancerStrategyOptions.Weighted,
      'Expected the existing weighted strategy',
    );
    expect(Object.keys(strategy.chains)).to.have.length(16);
    expect(strategy.chains.elysium.weighted).to.deep.equal({
      weight: 3n,
      tolerance: 3n,
    });
    expect(strategy.chains.elysium.bridgeMinAcceptedAmount).to.equal(2500);
    expect(strategy.chains.elysium.enabled).to.equal(false);
    for (const override of Object.values(
      strategy.chains.elysium.override ?? {},
    )) {
      expect(override.enabled).not.to.equal(true);
    }
    expect(strategy.chains.elysium.executionType).to.equal(
      ExecutionType.Inventory,
    );
    expect(strategy.chains.elysium.externalBridge).to.equal(
      ExternalBridgeType.Relay,
    );
    expect(strategy.chains.base.bridgeMinAcceptedAmount).to.equal(3500);
    expect(strategy.chains.base.override?.bsc.externalBridge).to.equal(
      ExternalBridgeType.SwapsXyz,
    );
    expect(strategy.chains.bsc.externalBridge).to.equal(
      ExternalBridgeType.SwapsXyz,
    );
    expect(strategy.chains.solanamainnet.externalBridge).to.equal(
      ExternalBridgeType.SwapsXyz,
    );
    for (const [chain, settings] of Object.entries(strategy.chains)) {
      if (chain === 'elysium' || chain === 'solanamainnet') continue;
      expect(settings.override?.elysium.executionType, chain).to.equal(
        ExecutionType.Inventory,
      );
      expect(
        settings.override?.elysium.bridgeMinAcceptedAmount,
        chain,
      ).to.equal(2500);
    }
  });

  it('prefers native deposits and disables all inventory exports from Elysium', () => {
    const { config } = readRebalancerConfig(configPath);
    const routes = config.inventoryRoutes;
    assert(routes, 'Expected physical inventory routes');
    expect(routes.hyperevm.elysium).to.deep.equal({
      externalBridge: ExternalBridgeType.ElysiumNative,
      priority: 1,
    });
    expect(routes.base.elysium.externalBridge).to.equal(
      ExternalBridgeType.Relay,
    );
    expect(routes.elysium.hyperevm.externalBridge).to.equal(
      ExternalBridgeType.Relay,
    );
    for (const [chain, destinations] of Object.entries(routes)) {
      if (chain === 'elysium' || chain === 'solanamainnet') continue;
      expect(destinations.elysium.externalBridge, chain).to.equal(
        chain === 'hyperevm'
          ? ExternalBridgeType.ElysiumNative
          : ExternalBridgeType.Relay,
      );
      expect(routes.elysium[chain].externalBridge, chain).to.equal(
        ExternalBridgeType.Relay,
      );
    }
    for (const route of Object.values(routes.elysium)) {
      expect(route.enabled).to.equal(false);
      expect(route.externalBridge).not.to.equal(
        ExternalBridgeType.ElysiumNative,
      );
    }
    expect(routes.solanamainnet.elysium.enabled).to.equal(false);
    expect(routes.elysium.solanamainnet.enabled).to.equal(false);
    const strategy = config.strategy[0];
    assert(strategy, 'Missing strategy');
    expect(Object.keys(routes.elysium)).to.have.members(
      Object.keys(strategy.chains).filter((chain) => chain !== 'elysium'),
    );
    expect(strategy.chains.solanamainnet.override?.elysium.enabled).to.equal(
      false,
    );
    expect(strategy.chains.elysium.override?.solanamainnet.enabled).to.equal(
      false,
    );
  });

  it('keeps the wider canary budget out of production configuration', () => {
    const { config } = readRebalancerConfig(configPath);
    expect(config.externalBridges?.relay?.defaultSlippage).to.equal(0.001);
    expect(config.externalBridges?.relay?.maxQuoteLossBps).to.equal(100);
    expect(config.externalBridges?.swapsxyz?.defaultSlippage).to.equal(0.005);
    expect(config.externalBridges?.swapsxyz?.maxQuoteLossBps).to.equal(50);
    expect(config.externalBridges?.elysiumNative?.maxNativeValueWei).to.equal(
      10_000_000_000_000_000n,
    );
  });
});
