import { expect } from 'chai';

import { Chains } from '../consts/chains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { buildAgentConfig } from './agentConfig.js';

describe('Agent config', () => {
  const args: Parameters<typeof buildAgentConfig> = [
    [Chains.ethereum],
    new MultiProvider(),
    {
      ethereum: {
        mailbox: '0xmailbox',
        interchainGasPaymaster: '0xgas',
        validatorAnnounce: '0xannounce',
        merkleTreeHook: '0xmerkle',
      },
    },
    { ethereum: 0 },
  ];

  it('Should generate a new agent config', () => {
    const result = buildAgentConfig(...args);
    expect(Object.keys(result)).to.deep.equal([
      'chains',
      'defaultRpcConsensusType',
    ]);
    expect(result.chains[Chains.ethereum].mailbox).to.equal('0xmailbox');
    expect(result.chains[Chains.ethereum].interchainGasPaymaster).to.equal(
      '0xgas',
    );
    expect(result.chains[Chains.ethereum].validatorAnnounce).to.equal(
      '0xannounce',
    );
    expect(result.chains[Chains.ethereum].merkleTreeHook).to.equal('0xmerkle');
  });
});
