import { expect } from 'chai';
import YAML from 'yaml';

import { KeyFunderHelmManager } from '../src/funding/key-funder.js';

describe('KeyFunderHelmManager', () => {
  it('includes sealevel chains in the generated keyfunder config for mainnet3', async () => {
    const manager = KeyFunderHelmManager.forEnvironment('mainnet3', 'test-commit');
    const helmValues = await manager.helmValues();

    expect(helmValues.hyperlane.chains).to.include('solanamainnet');
    expect(helmValues.hyperlane.chains).to.include('eclipsemainnet');

    const keyfunderConfig = YAML.parse(helmValues.hyperlane.keyfunderConfig);

    expect(keyfunderConfig.chains).to.have.property('solanamainnet');
    expect(keyfunderConfig.chains.solanamainnet.balances).to.have.property(
      'hyperlane-relayer',
    );
    expect(keyfunderConfig.chains).to.have.property('eclipsemainnet');
    expect(keyfunderConfig.chains.eclipsemainnet.balances).to.have.property(
      'hyperlane-relayer',
    );
  });
});
