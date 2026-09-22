import { rejects } from 'assert';
import { expect } from 'chai';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Sinon from 'sinon';
import { parse, parseAllDocuments, stringify } from 'yaml';

import { GithubRegistry } from '@hyperlane-xyz/registry';
import { TokenStandard } from '@hyperlane-xyz/sdk';

import { DockerImageRepos, mainnetDockerTags } from '../config/docker.js';
import { readRebalancerConfig } from '../src/rebalancer/config.js';
import {
  RebalancerHelmManager,
  buildRebalancerHelmValues,
} from '../src/rebalancer/helm.js';
import { HelmManager } from '../src/utils/helm.js';
import { getInfraPath } from '../src/utils/utils.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const options = {
  warpRouteId: 'TEST/route',
  environment: 'mainnet3' as const,
  registryCommit: 'a'.repeat(40),
  withMetrics: true,
  monitorOnly: false,
  chains: ['ethereum', 'tron', 'solanamainnet'],
};

function renderRebalancerValues(values: unknown) {
  const rendered = execFileSync(
    'helm',
    [
      'template',
      'test-rebalancer',
      path.join(getInfraPath(), 'helm/rebalancer'),
      '-f',
      '-',
    ],
    {
      input: stringify(values),
      encoding: 'utf8',
    },
  );
  return parseAllDocuments(rendered).map((doc) => {
    expect(
      doc.errors,
      'Helm output must not contain duplicate YAML keys',
    ).to.deep.equal([]);
    return doc.toJSON();
  });
}

describe('Rebalancer Helm deployment', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rebalancer-helm-'));
  });
  afterEach(() => {
    Sinon.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function config(extra: Record<string, unknown> = {}) {
    const filename = path.join(directory, 'config.yaml');
    fs.writeFileSync(
      filename,
      stringify({
        warpRouteId: options.warpRouteId,
        intentTTL: 1209600,
        strategy: {
          rebalanceStrategy: 'minAmount',
          chains: {
            ethereum: {
              bridge: ADDRESS,
              minAmount: { min: 1000, target: 3000, type: 'absolute' },
            },
          },
        },
        ...extra,
      }),
    );
    return readRebalancerConfig(filename);
  }

  it('keeps the default image and execution mode for other routes', () => {
    const values = buildRebalancerHelmValues(config(), options);
    expect(values.image).to.deep.equal({
      repository: DockerImageRepos.NODE_SERVICES,
      tag: mainnetDockerTags.rebalancer,
    });
    const documents = renderRebalancerValues(values);
    const secret = documents.find((d) => d.kind === 'ExternalSecret');
    expect(secret.spec.target.template.data).not.to.have.property(
      'SWAPSXYZ_API_KEY',
    );
    expect(secret.spec.target.template.data).not.to.have.property(
      'HYP_INVENTORY_KEY_TRON',
    );
    const container = documents.find((d) => d.kind === 'StatefulSet').spec
      .template.spec.containers[0];
    expect(container.env).to.deep.include({
      name: 'MONITOR_ONLY',
      value: 'false',
    });
    expect(container.image).to.equal(
      `${DockerImageRepos.NODE_SERVICES}:${mainnetDockerTags.rebalancer}`,
    );
  });

  for (const protocols of [
    [],
    ['ethereum'],
    ['tron'],
    ['sealevel'],
    ['ethereum', 'tron', 'sealevel'],
  ]) {
    for (const providers of [
      [],
      ['lifi'],
      ['swapsxyz'],
      ['lifi', 'swapsxyz'],
    ]) {
      it(`renders signer protocols ${protocols.join(',') || 'absent'} and providers ${providers.join(',') || 'absent'}`, () => {
        const loaded = config({
          ...(protocols.length
            ? {
                inventorySigners: Object.fromEntries(
                  protocols.map((p) => [
                    p,
                    p === 'sealevel' ? '1'.repeat(32) : ADDRESS,
                  ]),
                ),
              }
            : {}),
          ...(providers.length
            ? {
                externalBridges: Object.fromEntries(
                  providers.map((p) => [
                    p,
                    p === 'lifi' ? { integrator: 'rebalancer' } : {},
                  ]),
                ),
              }
            : {}),
        });
        const values = buildRebalancerHelmValues(loaded, options);
        expect(values.hyperlane.inventorySignerProtocols).to.have.members(
          protocols,
        );
        expect(values.hyperlane.externalBridgeProviders).to.have.members(
          providers,
        );
        const documents = renderRebalancerValues(values);
        const secret = documents.find((d) => d.kind === 'ExternalSecret');
        const data = secret.spec.target.template.data;
        expect('HYP_INVENTORY_KEY_TRON' in data).to.equal(
          protocols.includes('tron'),
        );
        expect('HYP_INVENTORY_KEY_SEALEVEL' in data).to.equal(
          protocols.includes('sealevel'),
        );
        expect('SWAPSXYZ_API_KEY' in data).to.equal(
          providers.includes('swapsxyz'),
        );
        const swaps = secret.spec.data.filter(
          (d: { secretKey: string }) => d.secretKey === 'swapsxyz_api_key',
        );
        expect(swaps).to.have.length(providers.includes('swapsxyz') ? 1 : 0);
        if (swaps.length)
          expect(swaps[0].remoteRef.key).to.equal('mainnet3-swapsxyz-api-key');
        const container = documents.find((d) => d.kind === 'StatefulSet').spec
          .template.spec.containers[0];
        expect(container.envFrom).to.deep.include({
          secretRef: { name: secret.spec.target.name },
        });
      });
    }
  }

  it('renders a dedicated secret, digest, registry pin and monitor-only mode', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const loaded = config({
      deployment: {
        imageTag: 'candidate',
        imageDigest: digest,
        swapsXyzApiKeySecret: 'mainnet3-swapsxyz-api-key-ousdt',
        registryCommit: options.registryCommit,
      },
      externalBridges: { swapsxyz: {} },
      inventorySigners: { ethereum: ADDRESS, tron: ADDRESS },
    });
    const values = buildRebalancerHelmValues(loaded, {
      ...options,
      monitorOnly: true,
    });
    const documents = renderRebalancerValues(values);
    const secret = documents.find((d) => d.kind === 'ExternalSecret');
    expect(
      secret.spec.data.find(
        (d: { secretKey: string }) => d.secretKey === 'swapsxyz_api_key',
      ).remoteRef.key,
    ).to.equal('mainnet3-swapsxyz-api-key-ousdt');
    const container = documents.find((d) => d.kind === 'StatefulSet').spec
      .template.spec.containers[0];
    expect(container.image).to.equal(
      `${DockerImageRepos.NODE_SERVICES}@${digest}`,
    );
    expect(container.env).to.deep.include({
      name: 'MONITOR_ONLY',
      value: 'true',
    });
    expect(container.env).to.deep.include({
      name: 'REGISTRY_URI',
      value: `https://github.com/hyperlane-xyz/hyperlane-registry/tree/${options.registryCommit}`,
    });
    const runtime = parse(values.hyperlane.rebalancerConfig);
    expect(runtime.intentTTL).to.equal(1209600);
    expect(runtime).not.to.have.property('deployment');
  });

  it('rejects invalid deployment metadata and a mismatched route', () => {
    expect(() => config({ deployment: { imageDigest: 'latest' } })).to.throw();
    expect(() => config({ deployment: { imageDgiest: 'typo' } })).to.throw();
    expect(() =>
      buildRebalancerHelmValues(config(), {
        ...options,
        warpRouteId: 'OTHER/route',
      }),
    ).to.throw('warp route ID mismatch');
  });

  it('preflights and renders without monitor removal, upgrade or cluster queries', async () => {
    config();
    const getWarpRoute = Sinon.stub(
      GithubRegistry.prototype,
      'getWarpRoute',
    ).resolves({
      tokens: [
        {
          chainName: 'ethereum',
          standard: TokenStandard.EvmHypCollateral,
          decimals: 6,
          symbol: 'TEST',
          name: 'Test',
          addressOrDenom: ADDRESS,
        },
      ],
    });
    const query = Sinon.stub(HelmManager, 'doesHelmReleaseExist').rejects(
      new Error('Unexpected cluster query'),
    );
    const upgrade = Sinon.stub(HelmManager.prototype, 'runHelmCommand').rejects(
      new Error('Unexpected mutation'),
    );
    const manager = new RebalancerHelmManager(
      options.warpRouteId,
      options.environment,
      options.registryCommit,
      '',
      '',
      true,
      true,
    );
    await manager.runPreflightChecks(
      path.relative(getInfraPath(), path.join(directory, 'config.yaml')),
    );
    expect(getWarpRoute.calledOnceWithExactly(options.warpRouteId)).to.equal(
      true,
    );
    expect(getWarpRoute.firstCall.thisValue.branch).to.equal(
      options.registryCommit,
    );
    expect((await manager.helmValues()).hyperlane.chains).to.deep.equal([
      'ethereum',
    ]);
    expect(await manager.renderManifest()).to.include('kind: StatefulSet');
    expect(query.called).to.equal(false);
    expect(upgrade.called).to.equal(false);
  });

  it('rejects routes missing from the pinned registry', async () => {
    config();
    Sinon.stub(GithubRegistry.prototype, 'getWarpRoute').resolves(null);
    const manager = new RebalancerHelmManager(
      options.warpRouteId,
      options.environment,
      options.registryCommit,
      '',
      '',
      true,
    );
    await rejects(
      manager.runPreflightChecks(
        path.relative(getInfraPath(), path.join(directory, 'config.yaml')),
      ),
      new Error(
        `Warp Route ID not found in registry at ${options.registryCommit}: ${options.warpRouteId}`,
      ),
    );
  });
});

describe('oUSDT production manifest', () => {
  it('renders the actual route YAML with its pinned credentials, image and limits', () => {
    const loaded = readRebalancerConfig(
      path.join(
        getInfraPath(),
        'config/environments/mainnet3/rebalancer/oUSDT/production-config.yaml',
      ),
    );
    const registryCommit = '0b7518b88967309b0ca30827ec418852873bdc7e';
    expect(loaded.deployment.registryCommit).to.equal(registryCommit);
    expect(loaded.deployment.imageDigest).to.match(/^sha256:[a-f0-9]{64}$/);
    const values = buildRebalancerHelmValues(loaded, {
      ...options,
      warpRouteId: 'oUSDT/production',
      registryCommit,
      chains: ['arbitrum', 'celo', 'ethereum', 'tron'],
      monitorOnly: true,
    });
    const documents = renderRebalancerValues(values);
    const secret = documents.find((d) => d.kind === 'ExternalSecret');
    expect(secret.spec.target.template.data).to.have.keys(
      'COINGECKO_API_KEY',
      'HYP_REBALANCER_KEY',
      'HYP_INVENTORY_KEY',
      'HYP_INVENTORY_KEY_ETHEREUM',
      'HYP_INVENTORY_KEY_TRON',
      'SWAPSXYZ_API_KEY',
      'RPC_URL_ARBITRUM',
      'RPC_URL_CELO',
      'RPC_URL_ETHEREUM',
      'RPC_URL_TRON',
    );
    expect(
      secret.spec.data.find(
        (d: { secretKey: string }) => d.secretKey === 'swapsxyz_api_key',
      ).remoteRef.key,
    ).to.equal('mainnet3-swapsxyz-api-key-ousdt');
    expect(secret.spec.target.template.data.HYP_INVENTORY_KEY_TRON).to.equal(
      secret.spec.target.template.data.HYP_INVENTORY_KEY_ETHEREUM,
    );
    const sts = documents.find((d) => d.kind === 'StatefulSet');
    const container = sts.spec.template.spec.containers[0];
    expect(container.envFrom).to.deep.equal([
      { secretRef: { name: secret.spec.target.name } },
    ]);
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
    expect(runtime.inventorySigners).to.deep.equal({
      ethereum: '0x6056e8E8e5Db30ffa9d721e3D73b3D558011FdA9',
      tron: '0x6056e8E8e5Db30ffa9d721e3D73b3D558011FdA9',
    });
    expect(runtime.externalBridges).to.deep.equal({
      lifi: { integrator: 'rebalancer' },
      swapsxyz: { defaultSlippage: 0.005, maxQuoteLossBps: 250 },
    });
    const chains = runtime.strategy.chains;
    expect(chains.ethereum.minAmount).to.deep.equal({
      min: 640000,
      target: 650000,
      type: 'absolute',
    });
    for (const chain of ['arbitrum', 'celo', 'tron']) {
      expect(chains[chain].minAmount).to.deep.equal({
        min: 1000,
        target: 3000,
        type: 'absolute',
      });
    }
    expect(chains.arbitrum.override.tron.statusAdapter).to.deep.equal({
      kind: 'lz_scan',
      sourceEid: 30110,
      destinationEid: 30420,
      sourceOft: '0x77652D5aba086137b595875263FC200182919B92',
      destinationOft: '0x3a08f76772e200653bb55c2a92998daca62e0e97',
    });
    expect(chains.tron.override.arbitrum.statusAdapter).to.deep.equal({
      kind: 'lz_scan',
      sourceEid: 30420,
      destinationEid: 30110,
      sourceOft: '0x3a08f76772e200653bb55c2a92998daca62e0e97',
      destinationOft: '0x77652D5aba086137b595875263FC200182919B92',
    });
  });
});
