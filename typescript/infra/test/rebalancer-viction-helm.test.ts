import { expect } from 'chai';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Sinon from 'sinon';
import { parse, parseAllDocuments, stringify } from 'yaml';

import { GithubRegistry } from '@hyperlane-xyz/registry';
import { WarpCoreConfigSchema } from '@hyperlane-xyz/sdk';

import { DockerImageRepos } from '../config/docker.js';
import { readRebalancerConfig } from '../src/rebalancer/config.js';
import { RebalancerHelmManager } from '../src/rebalancer/helm.js';
import { getInfraPath } from '../src/utils/utils.js';

describe('ETH Viction production manifest', () => {
  afterEach(() => Sinon.restore());
  it('renders swaps.xyz routing including Robinhood', async () => {
    const loaded = readRebalancerConfig(
      path.join(
        getInfraPath(),
        'config/environments/mainnet3/rebalancer/ETH/viction-config.yaml',
      ),
    );
    const registryCommit = loaded.deployment.registryCommit;
    expect(registryCommit).to.equal('a24bd88a0ce60fb862a5bd5a6ba63fb7a60d79bc');
    if (!registryCommit) throw new Error('Missing ETH/viction registry pin');

    expect(loaded.deployment.monitorOnly).to.equal(true);
    const warpCore = WarpCoreConfigSchema.parse(
      parse(
        fs.readFileSync(
          path.join(
            getInfraPath(),
            'test/fixtures/rebalancer/ETH-viction-warp-core.yaml',
          ),
          'utf8',
        ),
      ),
    );
    const getWarpRoute = Sinon.stub(
      GithubRegistry.prototype,
      'getWarpRoute',
    ).resolves(warpCore);
    const manager = new RebalancerHelmManager(
      'ETH/viction',
      'mainnet3',
      registryCommit,
      '',
      '',
      true,
      false,
    );
    await manager.runPreflightChecks(
      'config/environments/mainnet3/rebalancer/ETH/viction-config.yaml',
    );
    const values = await manager.helmValues();
    expect(getWarpRoute.calledOnceWithExactly('ETH/viction')).to.equal(true);
    expect(getWarpRoute.firstCall.thisValue.branch).to.equal(registryCommit);
    expect(values.hyperlane.chains).to.deep.equal(
      warpCore.tokens.map((token) => token.chainName),
    );
    const rendered = execFileSync(
      'helm',
      [
        'template',
        'test-viction',
        path.join(getInfraPath(), 'helm/rebalancer'),
        '-f',
        '-',
      ],
      { input: stringify(values), encoding: 'utf8' },
    );
    const documents = parseAllDocuments(rendered).map((document) => {
      expect(document.errors).to.deep.equal([]);
      return document.toJSON();
    });
    const secret = documents.find(
      (document) => document.kind === 'ExternalSecret',
    );
    for (const token of warpCore.tokens) {
      expect(secret.spec.target.template.data).to.have.property(
        `RPC_URL_${token.chainName.toUpperCase()}`,
      );
    }
    expect(
      secret.spec.data.find(
        (item: { secretKey: string }) => item.secretKey === 'swapsxyz_api_key',
      ).remoteRef.key,
    ).to.equal('mainnet3-swapsxyz-api-key');

    const statefulSet = documents.find(
      (document) => document.kind === 'StatefulSet',
    );
    const container = statefulSet.spec.template.spec.containers[0];
    expect(loaded.deployment.imageDigest).to.match(/^sha256:[0-9a-f]{64}$/);
    expect(container.image).to.equal(
      `${DockerImageRepos.NODE_SERVICES}@${loaded.deployment.imageDigest}`,
    );
    expect(container.env).to.deep.include({
      name: 'MONITOR_ONLY',
      value: 'true',
    });

    const runtime = parse(
      documents.find((document) => document.kind === 'ConfigMap').data[
        'rebalancer-config.yaml'
      ],
    );
    expect(runtime).not.to.have.property('deployment');
    expect(runtime.intentTTL).to.equal(1209600);
    expect(runtime.externalBridges).to.deep.equal({
      swapsxyz: {
        defaultSlippage: 0.005,
        maxQuoteLossBps: 50,
        maxEvmNativeFeeWei: '10000000000000000',
      },
    });
    expect(Object.keys(runtime.strategy.chains)).to.deep.equal([
      'arbitrum',
      'base',
      'ethereum',
      'optimism',
      'robinhood',
    ]);
    for (const chain of ['arbitrum', 'base', 'ethereum']) {
      expect(runtime.strategy.chains[chain].weighted).to.deep.equal({
        weight: 19,
        tolerance: 5,
      });
      expect(
        runtime.strategy.chains[chain].override.robinhood
          .bridgeMinAcceptedAmount,
      ).to.equal(0.1);
    }
    expect(runtime.strategy.chains.optimism.weighted).to.deep.equal({
      weight: 15,
      tolerance: 5,
    });
    expect(
      runtime.strategy.chains.optimism.override.robinhood
        .bridgeMinAcceptedAmount,
    ).to.equal(0.1);
    expect(runtime.strategy.chains.robinhood.weighted).to.deep.equal({
      weight: 8,
      tolerance: 5,
    });
    expect(runtime.strategy.chains.robinhood.bridgeMinAcceptedAmount).to.equal(
      0.1,
    );
  });
});
