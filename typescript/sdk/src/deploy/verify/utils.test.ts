import { describe, expect } from '@jest/globals';

import { ChainMap, ChainName } from '../../types.js';

import { ContractVerificationInput } from './types.js';
import { shouldAddVerificationInput } from './utils.js';

describe('shouldAddVerificationInput', () => {
  it('should return true if the artifact does not exist in the verification inputs', () => {
    const verificationInputs: ChainMap<ContractVerificationInput[]> = {
      Ethereum: [
        {
          name: 'ContractA',
          address: '0x123',
          constructorArguments: 'args',
          isProxy: false,
        },
      ],
    };
    const newArtifact: ContractVerificationInput = {
      name: 'ContractB',
      address: '0x456',
      constructorArguments: 'argsB',
      isProxy: true,
    };
    const chain: ChainName = 'Ethereum';
    expect(
      shouldAddVerificationInput(verificationInputs, chain, newArtifact),
    ).toBe(true);
  });

  it('should return false if the artifact already exists in the verification inputs', () => {
    const verificationInputs: ChainMap<ContractVerificationInput[]> = {
      Ethereum: [
        {
          name: 'ContractA',
          address: '0x123',
          constructorArguments: 'args',
          isProxy: false,
        },
      ],
    };
    const existingArtifact: ContractVerificationInput = {
      name: 'ContractA',
      address: '0x123',
      constructorArguments: 'args',
      isProxy: false,
    };
    const chain: ChainName = 'Ethereum';
    expect(
      shouldAddVerificationInput(verificationInputs, chain, existingArtifact),
    ).toBe(false);
  });
});
