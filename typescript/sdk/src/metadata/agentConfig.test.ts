import { expect } from 'vitest';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { buildAgentConfig } from './agentConfig.js';

describe('Agent config', () => {
  const args: Parameters<typeof buildAgentConfig> = [
    [TestChainName.test1],
    MultiProvider.createTestMultiProvider(),
    {
      test1: {
        mailbox: '0xmailbox',
        interchainGasPaymaster: '0xgas',
        validatorAnnounce: '0xannounce',
        merkleTreeHook: '0xmerkle',
      },
    },
    { test1: 0 },
  ];

  it('Should generate a new agent config', () => {
    const result = buildAgentConfig(...args);
    expect(result.chains[TestChainName.test1].mailbox).toBe('0xmailbox');
    expect(result.chains[TestChainName.test1].interchainGasPaymaster).toBe(
      '0xgas',
    );
    expect(result.chains[TestChainName.test1].validatorAnnounce).toBe(
      '0xannounce',
    );
    expect(result.chains[TestChainName.test1].merkleTreeHook).toBe('0xmerkle');
  });
});
