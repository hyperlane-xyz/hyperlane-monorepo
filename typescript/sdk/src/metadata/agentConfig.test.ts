import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { RelayerAgentConfigSchema, buildAgentConfig } from './agentConfig.js';

describe('RelayerAgentConfigSchema feeToken gate', () => {
  const FEE_TOKEN = '0x0000000000000000000000000000000000000005';

  // Minimal chain metadata satisfying AgentChainMetadataSchema.
  const chainMetadata = (name: string, domainId: number) => ({
    name,
    domainId,
    chainId: domainId,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'http://localhost:8545' }],
    mailbox: '0x0000000000000000000000000000000000000001',
    interchainGasPaymaster: '0x0000000000000000000000000000000000000002',
    validatorAnnounce: '0x0000000000000000000000000000000000000003',
    merkleTreeHook: '0x0000000000000000000000000000000000000004',
  });

  const config = (overrides: Record<string, unknown>) => ({
    relayChains: 'legacy',
    chains: { legacy: chainMetadata('legacy', 1000) },
    gasPaymentEnforcement: [
      { type: 'minimum', payment: '1', feeToken: FEE_TOKEN },
    ],
    ...overrides,
  });

  it('rejects non-zero feeToken policy', () => {
    const result = RelayerAgentConfigSchema.safeParse(config({}));
    expect(result.success).to.be.false;
    if (!result.success) {
      expect(result.error.issues[0].message).to.contain(
        '`feeToken` gas payment enforcement is not supported',
      );
    }
  });

  it('allows unset feeToken', () => {
    const result = RelayerAgentConfigSchema.safeParse(
      config({
        gasPaymentEnforcement: [{ type: 'onChainFeeQuoting' }],
      }),
    );
    expect(result.success).to.be.true;
  });

  it('allows native (zero) feeToken', () => {
    const result = RelayerAgentConfigSchema.safeParse(
      config({
        gasPaymentEnforcement: [
          {
            type: 'minimum',
            payment: '1',
            feeToken: '0x0000000000000000000000000000000000000000',
          },
        ],
      }),
    );
    expect(result.success).to.be.true;
  });
});

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
    expect(result.chains[TestChainName.test1].mailbox).to.equal('0xmailbox');
    expect(result.chains[TestChainName.test1].interchainGasPaymaster).to.equal(
      '0xgas',
    );
    expect(result.chains[TestChainName.test1].validatorAnnounce).to.equal(
      '0xannounce',
    );
    expect(result.chains[TestChainName.test1].merkleTreeHook).to.equal(
      '0xmerkle',
    );
  });
});
