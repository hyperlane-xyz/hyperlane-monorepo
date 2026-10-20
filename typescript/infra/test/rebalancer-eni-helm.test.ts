import { expect } from 'chai';
import { execFileSync } from 'child_process';
import path from 'path';
import { parse, parseAllDocuments, stringify } from 'yaml';

import { readRebalancerConfig } from '../src/rebalancer/config.js';
import { buildRebalancerHelmValues } from '../src/rebalancer/helm.js';
import { getInfraPath } from '../src/utils/utils.js';

describe('USDT Eni production manifest', () => {
  it('renders directional swaps.xyz and deBridge routing', () => {
    const loaded = readRebalancerConfig(
      path.join(
        getInfraPath(),
        'config/environments/mainnet3/rebalancer/USDT/eni-config.yaml',
      ),
    );
    const registryCommit = loaded.deployment.registryCommit;
    expect(registryCommit).to.equal('a24bd88a0ce60fb862a5bd5a6ba63fb7a60d79bc');
    if (!registryCommit) throw new Error('Missing USDT/eni registry pin');

    const values = buildRebalancerHelmValues(loaded, {
      warpRouteId: 'USDT/eni',
      environment: 'mainnet3',
      registryCommit,
      chains: [
        'arbitrum',
        'base',
        'bsc',
        'eni',
        'ethereum',
        'optimism',
        'polygon',
        'tron',
      ],
      withMetrics: true,
      monitorOnly: false,
    });
    const rendered = execFileSync(
      'helm',
      [
        'template',
        'test-eni',
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
    expect(
      secret.spec.data.find(
        (item: { secretKey: string }) => item.secretKey === 'swapsxyz_api_key',
      ).remoteRef.key,
    ).to.equal('mainnet3-swapsxyz-api-key');

    const statefulSet = documents.find(
      (document) => document.kind === 'StatefulSet',
    );
    expect(statefulSet.spec.template.spec.containers[0].image).to.equal(
      'ghcr.io/hyperlane-xyz/hyperlane-node-services:79f9608-20261020-142721',
    );
    expect(statefulSet.spec.template.spec.containers[0].env).to.deep.include({
      name: 'MONITOR_ONLY',
      value: 'false',
    });

    const runtime = parse(
      documents.find((document) => document.kind === 'ConfigMap').data[
        'rebalancer-config.yaml'
      ],
    );
    expect(runtime).not.to.have.property('deployment');
    expect(runtime.intentTTL).to.equal(1209600);
    expect(runtime.externalBridges).to.deep.equal({
      debridge: {
        maxFeeBps: 50,
        maxTronNativeValueSun: 20000000,
      },
      swapsxyz: {
        defaultSlippage: 0.005,
        maxQuoteLossBps: 50,
        maxEvmNativeFeeWei: '10000000000000000',
      },
    });
    expect(runtime.strategy.chains.bsc).to.deep.include({
      executionType: 'inventory',
      externalBridge: 'swapsxyz',
      minAmount: { min: 3000, target: 4500, type: 'absolute' },
    });
    expect(runtime.strategy.chains.tron).to.deep.include({
      executionType: 'inventory',
      externalBridge: 'debridge',
      minAmount: { min: 2000, target: 3500, type: 'absolute' },
    });
  });
});
