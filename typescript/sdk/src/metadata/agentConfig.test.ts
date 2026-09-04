import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import {
  AgentChainMetadataSchema,
  RelayerAgentConfigSchema,
  buildAgentConfig,
} from './agentConfig.js';

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

  it('rejects non-zero feeToken policy in stringified config', () => {
    const result = RelayerAgentConfigSchema.safeParse(
      config({
        gasPaymentEnforcement: JSON.stringify([
          { type: 'minimum', payment: '1', feeToken: FEE_TOKEN },
        ]),
      }),
    );
    expect(result.success).to.be.false;
  });

  it('rejects malformed stringified gas payment enforcement', () => {
    const result = RelayerAgentConfigSchema.safeParse(
      config({
        gasPaymentEnforcement: '[{"type":"minimum"',
      }),
    );

    expect(result.success).to.be.false;
    if (!result.success) {
      expect(result.error.issues[0].message).to.equal(
        'Invalid gasPaymentEnforcement JSON payload',
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

describe('AgentChainMetadataSchema additionalQuorumRpcUrls', () => {
  const baseChainMetadata = {
    name: 'legacy',
    domainId: 1000,
    chainId: 1000,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'http://localhost:8545' }],
    mailbox: '0x0000000000000000000000000000000000000001',
    interchainGasPaymaster: '0x0000000000000000000000000000000000000002',
    validatorAnnounce: '0x0000000000000000000000000000000000000003',
    merkleTreeHook: '0x0000000000000000000000000000000000000004',
  };

  it('parses and preserves a configured additionalQuorumRpcUrls array', () => {
    const additionalQuorumRpcUrls = [
      { http: 'http://quorum-a.example' },
      { http: 'http://quorum-b.example' },
    ];
    const result = AgentChainMetadataSchema.safeParse({
      ...baseChainMetadata,
      additionalQuorumRpcUrls,
    });
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.additionalQuorumRpcUrls).to.deep.equal(
        additionalQuorumRpcUrls,
      );
    }
  });

  it('leaves additionalQuorumRpcUrls unset when not configured', () => {
    const result = AgentChainMetadataSchema.safeParse(baseChainMetadata);
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.additionalQuorumRpcUrls).to.be.undefined;
    }
  });

  it('parses and preserves a configured customAdditionalQuorumRpcUrls override string', () => {
    const customAdditionalQuorumRpcUrls =
      'http://quorum-a.example,http://quorum-b.example';
    const result = AgentChainMetadataSchema.safeParse({
      ...baseChainMetadata,
      customAdditionalQuorumRpcUrls,
    });
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.customAdditionalQuorumRpcUrls).to.equal(
        customAdditionalQuorumRpcUrls,
      );
    }
  });

  it('leaves customAdditionalQuorumRpcUrls unset when not configured', () => {
    const result = AgentChainMetadataSchema.safeParse(baseChainMetadata);
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.customAdditionalQuorumRpcUrls).to.be.undefined;
    }
  });
});

describe('AgentChainMetadataSchema Sealevel process ALTs', () => {
  const altA = '5iPyGCTQ2xHaCxv9A8GDJzt2tHWL8t9FK8UwG3KoQsYo';
  const altB = '8MedWKtfT7QdMcZWDuVPx1iUrJRRZXDQpzyZAaqzQg2Z';
  const baseChainMetadata = {
    name: 'solanamainnet',
    domainId: 1_399_811_149,
    chainId: 101,
    protocol: ProtocolType.Sealevel,
    rpcUrls: [{ http: 'http://localhost:8899' }],
    mailbox: 'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi',
    interchainGasPaymaster: 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv',
    validatorAnnounce: 'Va1idatorAnnounce111111111111111111111111111',
    merkleTreeHook: 'Merk1eTreeHook11111111111111111111111111111',
  };

  it('accepts legacy singular and new plural process ALT fields', () => {
    expect(
      AgentChainMetadataSchema.safeParse({
        ...baseChainMetadata,
        mailboxProcessAlt: altA,
        processAltOverrides: [{ matchingList: [{}], addressLookupTable: altB }],
      }).success,
    ).to.equal(true);

    const plural = AgentChainMetadataSchema.safeParse({
      ...baseChainMetadata,
      mailboxProcessAlts: [altA, altB],
      processAltOverrides: [
        { matchingList: [{}], addressLookupTables: [altA, altB] },
      ],
    });
    expect(plural.success).to.equal(true);
    if (plural.success) {
      expect(plural.data.mailboxProcessAlts).to.deep.equal([altA, altB]);
      expect(plural.data.processAltOverrides).to.deep.equal([
        { matchingList: [{}], addressLookupTables: [altA, altB] },
      ]);
    }
  });

  it('rejects empty plural ALT lists', () => {
    expect(
      AgentChainMetadataSchema.safeParse({
        ...baseChainMetadata,
        mailboxProcessAlts: [],
      }).success,
    ).to.equal(false);
    expect(
      AgentChainMetadataSchema.safeParse({
        ...baseChainMetadata,
        processAltOverrides: [{ matchingList: [{}], addressLookupTables: [] }],
      }).success,
    ).to.equal(false);
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
