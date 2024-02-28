import { expect } from 'chai';
import { ethers } from 'ethers';

import { getContext } from './context.js';

describe('context', () => {
  it('Gets minimal read-only context correctly', async () => {
    const context = await getContext({ chainConfigPath: './fakePath' });
    expect(!!context.multiProvider).to.be.true;
    expect(context.customChains).to.eql({});
  });

  it('Handles conditional type correctly', async () => {
    const randomWallet = ethers.Wallet.createRandom();
    const context = await getContext({
      chainConfigPath: './fakePath',
      keyConfig: { key: randomWallet.privateKey },
    });
    expect(!!context.multiProvider).to.be.true;
    expect(context.customChains).to.eql({});
    expect(await context.signer.getAddress()).to.eql(randomWallet.address);
  });
});
