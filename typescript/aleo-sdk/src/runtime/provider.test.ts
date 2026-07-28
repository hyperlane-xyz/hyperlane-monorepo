import { expect } from 'chai';

import { AleoProvider as MainnetAleoProvider } from './mainnet.js';
import { AleoProvider as TestnetAleoProvider } from './testnet.js';

describe('Aleo runtime providers', () => {
  it('constructs providers for their configured network', () => {
    const mainnet = new MainnetAleoProvider(['https://rpc.example/mainnet'], 0);
    const testnet = new TestnetAleoProvider(['https://rpc.example/testnet'], 1);

    expect(mainnet.getRpcUrls()).to.deep.equal(['https://rpc.example']);
    expect(testnet.getRpcUrls()).to.deep.equal(['https://rpc.example']);
  });

  it('rejects the other network', () => {
    expect(() => new MainnetAleoProvider(['https://rpc.example'], 1)).to.throw(
      'Mainnet runtime cannot serve Aleo chain id 1',
    );
    expect(() => new TestnetAleoProvider(['https://rpc.example'], 0)).to.throw(
      'Testnet runtime cannot serve Aleo chain id 0',
    );
  });
});
