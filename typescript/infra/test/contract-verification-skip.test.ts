import { expect } from 'chai';

import { isContractVerificationViolation } from '../scripts/check/contract-verification-skip.js';

describe('contractVerification skip', () => {
  for (const name of [
    'contractVerificationStatus.proxy',
    'contractVerificationStatus.implementation',
    'contractVerificationStatus.proxyAdmin',
  ]) {
    it(`skips ${name}`, () => {
      expect(isContractVerificationViolation({ name })).to.equal(true);
    });
  }

  it('is case-insensitive on the violation name', () => {
    expect(
      isContractVerificationViolation({
        name: 'CONTRACTVERIFICATIONSTATUS.PROXY',
      }),
    ).to.equal(true);
  });

  it('does not skip unrelated violations', () => {
    for (const name of [
      'owner',
      'ownerStatus.0x0000000000000000000000000000000000000001',
      'maxFeeBps',
      'allowedRebalancingBridges',
      'scale',
    ]) {
      expect(isContractVerificationViolation({ name })).to.equal(false);
    }
  });
});
