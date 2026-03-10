import { expect } from 'chai';

import * as TronEthers from './index.js';

describe('tron ethers barrel', () => {
  it('re-exports the public ethers-compatible tron surface', () => {
    expect(TronEthers.TronWallet).to.be.a('function');
    expect(TronEthers.TronJsonRpcProvider).to.be.a('function');
    expect(TronEthers.TronContractFactory).to.be.a('function');
    expect(TronEthers.TronTransactionBuilder).to.be.a('function');
  });
});
