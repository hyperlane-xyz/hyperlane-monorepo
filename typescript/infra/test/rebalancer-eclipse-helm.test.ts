import { expect } from 'chai';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pino } from 'pino';
import Sinon from 'sinon';
import { parse, parseAllDocuments, stringify } from 'yaml';

import { GithubRegistry } from '@hyperlane-xyz/registry';
import { StrategyFactory } from '@hyperlane-xyz/rebalancer';
import {
  MultiProtocolProvider,
  WarpCore,
  WarpCoreConfigSchema,
} from '@hyperlane-xyz/sdk';

import { DockerImageRepos } from '../config/docker.js';
import { readRebalancerConfig } from '../src/rebalancer/config.js';
import { RebalancerHelmManager } from '../src/rebalancer/helm.js';
import { getInfraPath } from '../src/utils/utils.js';

describe('USDT Eclipse production manifest', () => {
  afterEach(() => Sinon.restore());
  it('renders its actual config with all three signers and its dedicated provider key', async () => {
    const loaded = readRebalancerConfig(
      path.join(
        getInfraPath(),
        'config/environments/mainnet3/rebalancer/USDT/eclipsemainnet-config.yaml',
      ),
    );
    const registryCommit = loaded.deployment.registryCommit;
    expect(registryCommit).to.equal('182e1be0c2df41b6e423b4934390daff1b6a72f9');
    if (!registryCommit) throw new Error('Missing Eclipse registry pin');
    expect(loaded.deployment.monitorOnly).to.equal(true);
    const warpCore = WarpCoreConfigSchema.parse(
      parse(
        fs.readFileSync(
          path.join(
            getInfraPath(),
            'test/fixtures/rebalancer/USDT-eclipsemainnet-warp-core.yaml',
          ),
          'utf8',
        ),
      ),
    );
    const tokens = Object.fromEntries(
      WarpCore.FromConfig(new MultiProtocolProvider({}), warpCore).tokens.map(
        (token) => [token.chainName, token],
      ),
    );
    // Representative collateral observed during review; live startup is checked
    // separately because balances can change after this fixture was recorded.
    const construct = (collateral: bigint) =>
      StrategyFactory.createStrategy(
        loaded.config.strategy,
        tokens,
        collateral,
        pino({ level: 'silent' }),
      );
    expect(() => construct(78_772_614_144n)).not.to.throw();
    expect(() => construct(74_999_999_999n)).to.throw(
      'Consider reducing the targets',
    );
    const getWarpRoute = Sinon.stub(
      GithubRegistry.prototype,
      'getWarpRoute',
    ).resolves(warpCore);
    const manager = new RebalancerHelmManager(
      'USDT/eclipsemainnet',
      'mainnet3',
      registryCommit,
      '',
      '',
      true,
      false,
    );
    await manager.runPreflightChecks(
      'config/environments/mainnet3/rebalancer/USDT/eclipsemainnet-config.yaml',
    );
    const values = await manager.helmValues();
    expect(getWarpRoute.calledOnceWithExactly('USDT/eclipsemainnet')).to.equal(
      true,
    );
    expect(getWarpRoute.firstCall.thisValue.branch).to.equal(registryCommit);
    expect(values.hyperlane.chains).to.deep.equal(
      warpCore.tokens.map((token) => token.chainName),
    );
    const rendered = execFileSync(
      'helm',
      [
        'template',
        'test-eclipse',
        path.join(getInfraPath(), 'helm/rebalancer'),
        '-f',
        '-',
      ],
      { input: stringify(values), encoding: 'utf8' },
    );
    const documents = parseAllDocuments(rendered).map((doc) => {
      expect(doc.errors).to.deep.equal([]);
      return doc.toJSON();
    });
    const secret = documents.find((d) => d.kind === 'ExternalSecret');
    for (const token of warpCore.tokens) {
      expect(secret.spec.target.template.data).to.have.property(
        `RPC_URL_${token.chainName.toUpperCase()}`,
      );
    }
    expect(values.hyperlane.chains).to.include('plasma');
    const keys = secret.spec.target.template.data;
    for (const protocol of ['ETHEREUM', 'SEALEVEL', 'TRON'])
      expect(keys).to.have.property(`HYP_INVENTORY_KEY_${protocol}`);
    expect(keys.HYP_INVENTORY_KEY_TRON).to.equal(
      keys.HYP_INVENTORY_KEY_ETHEREUM,
    );
    expect(keys.HYP_INVENTORY_KEY_SEALEVEL).not.to.equal(
      keys.HYP_INVENTORY_KEY_ETHEREUM,
    );
    expect(keys).to.have.property('SWAPSXYZ_API_KEY');
    expect(
      secret.spec.data.find(
        (d: { secretKey: string }) => d.secretKey === 'swapsxyz_api_key',
      ).remoteRef.key,
    ).to.equal('mainnet3-swapsxyz-api-key-usdt-eclipse');
    const sts = documents.find((d) => d.kind === 'StatefulSet');
    const container = sts.spec.template.spec.containers[0];
    expect(container.envFrom).to.deep.equal([
      { secretRef: { name: secret.spec.target.name } },
    ]);
    expect(loaded.deployment.imageDigest).to.match(/^sha256:[0-9a-f]{64}$/);
    expect(container.image).to.equal(
      `${DockerImageRepos.NODE_SERVICES}@${loaded.deployment.imageDigest}`,
    );
    expect(container.env).to.deep.include({
      name: 'MONITOR_ONLY',
      value: 'true',
    });
    expect(container.env).to.deep.include({
      name: 'REGISTRY_URI',
      value: `https://github.com/hyperlane-xyz/hyperlane-registry/tree/${registryCommit}`,
    });
    const runtime = parse(
      documents.find((d) => d.kind === 'ConfigMap').data[
        'rebalancer-config.yaml'
      ],
    );
    expect(runtime).not.to.have.property('deployment');
    expect(runtime).not.to.have.property('stateStore');
    expect(sts.spec).not.to.have.property('volumeClaimTemplates');
    expect(runtime.intentTTL).to.equal(1209600);
    expect(loaded.config.intentTTL).to.equal(1209600000);
    expect(runtime.externalBridges).to.deep.equal({
      swapsxyz: {
        defaultSlippage: 0.005,
        maxQuoteLossBps: 50,
        maxEvmNativeFeeWei: '10000000000000000',
        maxTronNativeFeeSun: 20000000,
        maxSolanaTransactionFeeLamports: 10000000,
        solanaTransactionFeeWarningLamports: 1000000,
        maxSolanaNativeSpendLamports: 10000000,
      },
    });
    expect(runtime.strategy.chains).not.to.have.property('plasma');
    const strategyChains = [
      'arbitrum',
      'bsc',
      'ethereum',
      'solanamainnet',
      'tron',
    ];
    expect(
      strategyChains.reduce(
        (total, chain) =>
          total + runtime.strategy.chains[chain].minAmount.target,
        0,
      ),
    ).to.equal(75000);
    for (const chain of strategyChains)
      expect(runtime.strategy.chains[chain].externalBridge).to.equal(
        'swapsxyz',
      );
    expect(
      runtime.strategy.chains.arbitrum.override.tron.statusAdapter.sourceEid,
    ).to.equal(30110);
    expect(
      runtime.strategy.chains.tron.override.arbitrum.statusAdapter
        .destinationEid,
    ).to.equal(30110);
    for (const [origin, destination] of [
      ['arbitrum', 'ethereum'],
      ['arbitrum', 'tron'],
      ['ethereum', 'arbitrum'],
      ['ethereum', 'tron'],
      ['tron', 'arbitrum'],
      ['tron', 'ethereum'],
    ]) {
      const route = runtime.strategy.chains[origin].override[destination];
      expect(route.executionType).to.equal('movableCollateral');
      expect(route.statusAdapter).not.to.have.property('destinationRecipient');
    }
  });
});
