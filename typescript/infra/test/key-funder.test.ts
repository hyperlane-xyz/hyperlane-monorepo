import { expect } from 'chai';
import YAML from 'yaml';

import { KeyFunderConfigSchema } from '@hyperlane-xyz/keyfunder';

import quoteSubmitterAddresses from '../config/quotesubmitter.json' with { type: 'json' };
import { KeyFunderHelmManager } from '../src/funding/key-funder.js';

describe('KeyFunderHelmManager', () => {
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
