import { expect } from 'chai';
import { keccak256, toUtf8Bytes } from 'ethers/lib/utils.js';

describe('EvmHypCollateralAdapter', () => {
  it('should return the correct role hash when using ethers keccak256', () => {
    // Obtained from doing keccak256('REBALANCER_ROLE') using chisel
    const expectedHash =
      '0xccc64574297998b6c3edf6078cc5e01268465ff116954e3af02ff3a70a730f46';

    expect(keccak256(toUtf8Bytes('REBALANCER_ROLE'))).to.equal(expectedHash);
  });
});
