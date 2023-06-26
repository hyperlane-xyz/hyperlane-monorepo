import { assert, expect } from 'chai';
import { ethers } from 'hardhat';

import { TestCcipReadIsm, TestCcipReadIsm__factory } from '../types';

describe('TestCcipReadIsm', () => {
  let ism: TestCcipReadIsm;

  before(async () => {
    const [signer] = await ethers.getSigners();
    const factory = new TestCcipReadIsm__factory(signer);
    ism = await factory.deploy([], '1', ['https://example.com']);
  });

  it('emits the right OffchainLookup message', async () => {
    try {
      await ism.getOffchainVerifyInfo('0x');
      assert.fail('No revert');
    } catch (e: any) {
      expect(e.errorName).to.eql('OffchainLookup');
      expect(e.errorArgs).to.eql([
        ism.address,
        ['https://example.com'],
        '0xdeadbeef',
        '0xbbac9bc8',
        '0x',
      ]);
    }
  });
});
