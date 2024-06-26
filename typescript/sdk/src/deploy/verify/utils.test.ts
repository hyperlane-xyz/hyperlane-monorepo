import { expect } from 'chai';

import { TestChainName } from '../../consts/testChains.js';
import { randomAddress } from '../../test/testUtils.js';
import { ChainMap, ChainName } from '../../types.js';

import { ContractVerificationInput } from './types.js';
import { shouldAddVerificationInput } from './utils.js';

describe('shouldAddVerificationInput', () => {
  const addressA = randomAddress();
  const addressB = randomAddress();
  it('should return true if the artifact does not exist in the verification inputs', () => {
    const verificationInputs: ChainMap<ContractVerificationInput[]> = {
      [TestChainName.test1]: [
        {
          name: 'ContractA',
          address: addressA,
          constructorArguments: 'args',
          isProxy: false,
        },
      ],
    };
    const newArtifact: ContractVerificationInput = {
      name: 'ContractB',
      address: addressB,
      constructorArguments: 'argsB',
      isProxy: true,
    };
    const chain: ChainName = TestChainName.test1;
    expect(
      shouldAddVerificationInput(verificationInputs, chain, newArtifact),
    ).to.equal(true);
  });

  it('should return false if the artifact already exists in the verification inputs', () => {
    const verificationInputs: ChainMap<ContractVerificationInput[]> = {
      [TestChainName.test2]: [
        {
          name: 'ContractA',
          address: addressA,
          constructorArguments: 'args',
          isProxy: false,
        },
      ],
    };
    const existingArtifact: ContractVerificationInput = {
      name: 'ContractA',
      address: addressA,
      constructorArguments: 'args',
      isProxy: false,
    };
    const chain: ChainName = TestChainName.test2;
    expect(
      shouldAddVerificationInput(verificationInputs, chain, existingArtifact),
    ).to.equal(false);
  });
});
