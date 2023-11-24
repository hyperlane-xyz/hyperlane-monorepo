import { jest } from '@jest/globals';

import { createMultisigConfig } from '../config/multisig.js';

jest.mock('@inquirer/prompts', () => ({
  input: jest.fn().mockImplementation((arg: any) => {
    const { message } = arg;
    if (message === 'Enter threshold of signers (number)') {
      return Promise.resolve({ thresholdInput: '2' });
    } else if (message === 'Enter validator addresses (comma separated list)') {
      return Promise.resolve({ validatorsInput: '0xAddress1,0xAddress2' });
    } else {
      throw new Error(`Unexpected message: ${message}`);
    }
    // Add other conditions as needed
  }),
}));

describe('createMultisigConfig', () => {
  it('should create a valid multisig config with correct user inputs', async () => {
    // Call your function and assertions
    // ...

    const config = await createMultisigConfig({
      format: 'json',
      outPath: 'testConfig.json',
      chainConfigPath: 'testChainConfig.json',
    });
    console.log(config);
  });
});
