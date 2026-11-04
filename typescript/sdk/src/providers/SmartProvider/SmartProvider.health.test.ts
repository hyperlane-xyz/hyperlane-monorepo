import { expect } from 'chai';
import { BigNumber, type providers } from 'ethers';
import sinon from 'sinon';

import { HyperlaneSmartProvider } from './SmartProvider.js';

const block: providers.Block = {
  number: 1,
  hash: `0x${'01'.repeat(32)}`,
  parentHash: `0x${'00'.repeat(32)}`,
  nonce: '0x0000000000000000',
  difficulty: 0,
  _difficulty: BigNumber.from(0),
  gasLimit: BigNumber.from(1),
  gasUsed: BigNumber.from(0),
  miner: '0x1111111111111111111111111111111111111111',
  extraData: '0x',
  timestamp: 1,
  transactions: [],
};

describe('SmartProvider health check ownership', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers();
  });

  afterEach(() => sandbox.restore());

  it('retires its polling loop after a health deadline expires', async () => {
    const provider = HyperlaneSmartProvider.fromRpcUrl(
      1,
      'https://example.com',
    );
    const read = sandbox.stub(provider, 'getBlock').resolves(block);
    const checking = provider.isHealthy(2, 100);
    await clock.tickAsync(100);
    expect(await checking).to.be.false;
    const callsAtDeadline = read.callCount;
    await clock.tickAsync(5000);
    expect(read.callCount).to.equal(callsAtDeadline);
    expect(clock.countTimers()).to.equal(0);
  });

  it('does not admit another read when an in-flight read returns after timeout', async () => {
    const provider = HyperlaneSmartProvider.fromRpcUrl(
      1,
      'https://example.com',
    );
    let finish: (result: providers.Block) => void = () => {
      throw new Error('Read not admitted');
    };
    const read = sandbox.stub(provider, 'getBlock').returns(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const checking = provider.isHealthy(2, 100);
    await clock.tickAsync(100);
    expect(await checking).to.be.false;
    finish(block);
    await clock.tickAsync(5000);
    expect(read.calledOnce).to.be.true;
    expect(clock.countTimers()).to.equal(0);
  });
});
