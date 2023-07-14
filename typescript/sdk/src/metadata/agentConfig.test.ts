import { expect } from 'chai';

import { Chains } from '../consts/chains';
import { MultiProvider } from '../providers/MultiProvider';

import {
  buildAgentConfig,
  buildAgentConfigDeprecated,
  buildAgentConfigNew,
} from './agentConfig';

describe('Agent config', () => {
  const args: Parameters<typeof buildAgentConfig> = [
    [Chains.ethereum],
    new MultiProvider(),
    {
      ethereum: {
        mailbox: '0xmailbox',
        interchainGasPaymaster: '0xgas',
        validatorAnnounce: '0xannounce',
      },
    },
    { ethereum: 0 },
  ];

  it('Should generate a deprecated agent config', () => {
    const result = buildAgentConfigDeprecated(...args);
    expect(Object.keys(result)).to.deep.equal(['chains']);
  });

  it('Should generate a new agent config', () => {
    const result = buildAgentConfigNew(...args);
    expect(Object.keys(result)).to.deep.equal([Chains.ethereum]);
  });

  it('Should generate a combined agent config', () => {
    const result = buildAgentConfig(...args);
    expect(Object.keys(result)).to.deep.equal([Chains.ethereum, 'chains']);
  });
});
