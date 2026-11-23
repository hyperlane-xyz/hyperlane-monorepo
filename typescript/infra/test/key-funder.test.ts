import { expect } from 'chai';
import YAML from 'yaml';

import { KeyFunderConfigSchema } from '@hyperlane-xyz/keyfunder';

import path from 'path';

import { readRebalancerConfig } from '../src/rebalancer/config.js';
import { getInfraPath } from '../src/utils/utils.js';

import quoteSubmitterAddresses from '../config/quotesubmitter.json' with { type: 'json' };
import { KeyFunderHelmManager } from '../src/funding/key-funder.js';

describe('KeyFunderHelmManager', () => {
  it('funds Elysium and HyperEVM gas for the configured inventory address', async () => {
    const manager = KeyFunderHelmManager.forEnvironment(
      'mainnet3',
      'test-registry-commit',
    );
    const values = await manager.helmValues();
    const config = KeyFunderConfigSchema.parse(
      YAML.parse(values.hyperlane.keyfunderConfig),
    );
    const route = readRebalancerConfig(
      path.join(
        getInfraPath(),
        'config/environments/mainnet3/rebalancer/USDC/eclipsemainnet-config.yaml',
      ),
    );
    const role = 'hyperlane-inventoryrebalancer';
    expect(config.roles[role].address).to.equal(
      route.config.inventorySigners?.ethereum?.address,
    );
    expect(config.chains.elysium.balances?.[role]).to.equal('0.1');
    expect(config.chains.hyperevm.balances?.[role]).to.equal('0.1');
  });

  it('opts Tempo into pathUSD funding without changing native-send chains', async () => {
    const manager = KeyFunderHelmManager.forEnvironment(
      'mainnet3',
      'test-registry-commit',
    );
    const values = await manager.helmValues();
    const config = KeyFunderConfigSchema.parse(
      YAML.parse(values.hyperlane.keyfunderConfig),
    );
    expect(config.chains.tempo.erc20GasToken).to.deep.equal({
      address: '0x20c0000000000000000000000000000000000000',
      decimals: 6,
    });
    expect(config.chains.tempo.balances?.['hyperlane-relayer']).to.equal('25');
    expect(config.chains.tempo.igp?.address).to.be.a('string');
    expect(config.chains.arc.erc20GasToken).to.equal(undefined);
    expect(config.chains.ethereum.erc20GasToken).to.equal(undefined);
  });
  it('funds the quote submitter only on CROSS/moonpay EVM origins', async () => {
    const manager = KeyFunderHelmManager.forEnvironment(
      'mainnet3',
      'test-registry-commit',
    );
    const values = await manager.helmValues();
    const config = KeyFunderConfigSchema.parse(
      YAML.parse(values.hyperlane.keyfunderConfig),
    );
    const role = 'hyperlane-quotesubmitter';
    const expectedBalances = new Map([
      ['arbitrum', '0.02'],
      ['base', '0.02'],
      ['bsc', '0.02'],
      ['ethereum', '0.02'],
      ['katana', '0.04'],
      ['polygon', '40'],
    ]);

    expect(config.roles[role].address).to.equal(
      quoteSubmitterAddresses.mainnet3.hyperlane,
    );

    const fundedChains: string[] = [];
    for (const [chain, chainConfig] of Object.entries(config.chains)) {
      const balance = chainConfig.balances?.[role];
      expect(balance).to.equal(expectedBalances.get(chain));
      if (balance) fundedChains.push(chain);
    }
    expect(fundedChains.sort()).to.deep.equal(
      [...expectedBalances.keys()].sort(),
    );
  });
});
