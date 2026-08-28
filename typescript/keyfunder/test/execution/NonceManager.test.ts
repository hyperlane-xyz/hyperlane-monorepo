import { expect } from 'chai';
import sinon from 'sinon';
import { ethers } from 'ethers';
import { NonceManager } from '../../src/execution/NonceManager';

describe('NonceManager', () => {
  let nonceManager: NonceManager;
  let mockProvider: any;

  beforeEach(() => {
    nonceManager = new NonceManager();
    mockProvider = sinon.createStubInstance(ethers.JsonRpcProvider);
    mockProvider.getTransactionCount.resolves(10);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should initialize and increment nonce sequentially', async () => {
    const address = '0x1234567890123456789012345678901234567890';
    const chain = 'ethereum';

    const nonce1 = await nonceManager.getAndIncrementNonce(chain, address, mockProvider);
    expect(nonce1).to.equal(10);

    const nonce2 = await nonceManager.getAndIncrementNonce(chain, address, mockProvider);
    expect(nonce2).to.equal(11);

    const nonce3 = await nonceManager.getAndIncrementNonce(chain, address, mockProvider);
    expect(nonce3).to.equal(12);

    expect(mockProvider.getTransactionCount.calledOnce).to.be.true;
  });

  it('should handle concurrent getAndIncrement calls without nonce collision', async () => {
    const address = '0xConcurrentAddress';
    const chain = 'ethereum';

    // Simulate 10 concurrent requests
    const promises = Array.from({ length: 10 }).map(() =>
      nonceManager.getAndIncrementNonce(chain, address, mockProvider)
    );

    const nonces = await Promise.all(promises);
    expect(nonces).to.have.lengthOf(10);
    // Nonces should be strictly 10, 11, 12, ... 19
    const sorted = [...nonces].sort((a, b) => a - b);
    expect(sorted).to.deep.equal([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('should resync nonce from provider on demand', async () => {
    const address = '0xResyncAddress';
    const chain = 'ethereum';

    await nonceManager.getAndIncrementNonce(chain, address, mockProvider); // 10, now cached at 11

    // Network mined some txs or was out of sync
    mockProvider.getTransactionCount.resolves(15);

    const resynced = await nonceManager.resync(chain, address, mockProvider);
    expect(resynced).to.equal(15);

    const next = await nonceManager.getAndIncrementNonce(chain, address, mockProvider);
    expect(next).to.equal(15);
  });
});
