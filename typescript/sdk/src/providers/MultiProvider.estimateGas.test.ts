import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import { TestChainName, test1 } from '../consts/testChains.js';
import { MultiProvider } from './MultiProvider.js';

describe('MultiProvider estimateGas', () => {
  it('uses the signer address as the gas estimation sender', async () => {
    const multiProvider = new MultiProvider({
      [TestChainName.test1]: test1,
    });
    const signerAddress = '0x16626CD24Fd1F228a031e48B77602Ae25f8930dB';
    const provider = {
      estimateGas: sinon.stub().resolves(BigNumber.from(75_794)),
    } as any;
    const signer = {
      provider,
      getAddress: sinon.stub().resolves(signerAddress),
    } as any;

    multiProvider.providers[TestChainName.test1] = provider;
    multiProvider.signers[TestChainName.test1] = signer;

    const gas = await multiProvider.estimateGas(TestChainName.test1, {
      to: '0xd9cbf08cac905f78d961a72716ef8eed3ab7e5eb',
      data: '0x1234',
      gasLimit: BigNumber.from(100_000),
      gasPrice: BigNumber.from(1),
      maxPriorityFeePerGas: BigNumber.from(2),
      maxFeePerGas: BigNumber.from(3),
    });

    expect(gas.toNumber()).to.equal(75_794);
    expect(provider.estimateGas.calledOnce).to.be.true;
    const txReq = provider.estimateGas.firstCall.args[0];
    expect(txReq.from).to.equal(signerAddress);
    expect(txReq.gasLimit).to.be.undefined;
    expect(txReq.gasPrice).to.be.undefined;
    expect(txReq.maxPriorityFeePerGas).to.be.undefined;
    expect(txReq.maxFeePerGas).to.be.undefined;
  });

  it('uses an explicit from address when provided', async () => {
    const multiProvider = new MultiProvider({
      [TestChainName.test1]: test1,
    });
    const explicitFrom = '0x221fa9cbafcd6c1c3d206571cf4427703e023ffa';
    const provider = {
      estimateGas: sinon.stub().resolves(BigNumber.from(50_000)),
    } as any;
    const signer = {
      provider,
      getAddress: sinon
        .stub()
        .resolves('0x16626CD24Fd1F228a031e48B77602Ae25f8930dB'),
    } as any;

    multiProvider.providers[TestChainName.test1] = provider;
    multiProvider.signers[TestChainName.test1] = signer;

    await multiProvider.estimateGas(
      TestChainName.test1,
      {
        to: '0xd9cbf08cac905f78d961a72716ef8eed3ab7e5eb',
        data: '0x1234',
      },
      explicitFrom,
    );

    expect(provider.estimateGas.calledOnce).to.be.true;
    expect(provider.estimateGas.firstCall.args[0].from).to.equal(explicitFrom);
    expect(signer.getAddress.called).to.be.false;
  });
});
