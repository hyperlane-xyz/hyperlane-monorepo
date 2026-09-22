import { expect } from 'chai';
import { execFileSync } from 'child_process';
import path from 'path';
import { parse, parseAllDocuments, stringify } from 'yaml';

import { readRebalancerConfig } from '../src/rebalancer/config.js';
import { buildRebalancerHelmValues } from '../src/rebalancer/helm.js';
import { getInfraPath } from '../src/utils/utils.js';

describe('USDT Eclipse production manifest', () => {
  it('renders its actual config with all three signers and its dedicated provider key', () => {
    const loaded = readRebalancerConfig(
      path.join(
        getInfraPath(),
        'config/environments/mainnet3/rebalancer/USDT/eclipsemainnet-config.yaml',
      ),
    );
    const registryCommit = loaded.deployment.registryCommit;
    expect(registryCommit).to.equal('182e1be0c2df41b6e423b4934390daff1b6a72f9');
    if (!registryCommit) throw new Error('Missing Eclipse registry pin');
    const chains = [
      'arbitrum',
      'bsc',
      'ethereum',
      'plasma',
      'solanamainnet',
      'tron',
      'eclipsemainnet',
    ];
    const values = buildRebalancerHelmValues(loaded, {
      warpRouteId: 'USDT/eclipsemainnet',
      environment: 'mainnet3',
      registryCommit,
      chains,
      withMetrics: true,
      monitorOnly: true,
    });
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
    expect(container.image).to.equal(
      loaded.deployment.imageDigest
        ? `ghcr.io/hyperlane-xyz/hyperlane-node-services@${loaded.deployment.imageDigest}`
        : `ghcr.io/hyperlane-xyz/hyperlane-node-services:${loaded.deployment.imageTag}`,
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
      debridge: {},
      swapsxyz: {
        defaultSlippage: 0.005,
        maxQuoteLossBps: 250,
        maxSolanaNativeSpendLamports: 10000000,
      },
    });
    expect(runtime.strategy.chains).not.to.have.property('plasma');
    expect(
      Object.keys(runtime.strategy.chains).reduce(
        (total, chain) =>
          total + runtime.strategy.chains[chain].minAmount.target,
        0,
      ),
    ).to.equal(90000);
    expect(
      runtime.strategy.chains.arbitrum.override.tron.statusAdapter.sourceEid,
    ).to.equal(30110);
    expect(
      runtime.strategy.chains.tron.override.arbitrum.statusAdapter
        .destinationEid,
    ).to.equal(30110);
  });
});
