import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import {
  AgentChainMetadataSchema,
  AgentSignerKeyType,
  RelayerAgentConfigSchema,
  RpcConsensusType,
  ValidatorAgentConfigSchema,
  buildAgentConfig,
} from './agentConfig.js';

describe('ValidatorAgentConfigSchema maxSignConcurrency', () => {
  const schema = ValidatorAgentConfigSchema.shape.maxSignConcurrency;

  it('accepts values from 1 through 1,000', () => {
    expect(schema.safeParse(1).success).to.be.true;
    expect(schema.safeParse(1_000).success).to.be.true;
  });

  it('rejects values outside the configured bounds', () => {
    expect(schema.safeParse(0).success).to.be.false;
    expect(schema.safeParse(1_001).success).to.be.false;
  });
});

describe('AgentChainMetadataSchema index.from', () => {
  it('accepts negative relative block offsets', () => {
    const result = AgentChainMetadataSchema.safeParse({
      name: 'legacy',
      domainId: 1000,
      chainId: 1000,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'http://localhost:8545' }],
      mailbox: '0x0000000000000000000000000000000000000001',
      interchainGasPaymaster: '0x0000000000000000000000000000000000000002',
      validatorAnnounce: '0x0000000000000000000000000000000000000003',
      merkleTreeHook: '0x0000000000000000000000000000000000000004',
      index: { from: -10_000 },
    });

    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.index?.from).to.equal(-10_000);
    }
  });
});

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

  it('accepts only WebSocket schemes for the scraper URL', () => {
    expect(
      RelayerAgentConfigSchema.safeParse(
        config({
          gasPaymentEnforcement: [{ type: 'onChainFeeQuoting' }],
          websocketUrl: 'wss://scraper.example/ws/events',
        }),
      ).success,
    ).to.be.true;
    expect(
      RelayerAgentConfigSchema.safeParse(
        config({
          gasPaymentEnforcement: [{ type: 'onChainFeeQuoting' }],
          websocketUrl: 'https://scraper.example/ws/events',
        }),
      ).success,
    ).to.be.false;
  });

  it('requires a WebSocket URL when scraper authority is enabled', () => {
    expect(
      RelayerAgentConfigSchema.safeParse(
        config({
          gasPaymentEnforcement: [{ type: 'onChainFeeQuoting' }],
          websocketAuthorityEnabled: true,
        }),
      ).success,
    ).to.be.false;
    expect(
      RelayerAgentConfigSchema.safeParse(
        config({
          gasPaymentEnforcement: [{ type: 'onChainFeeQuoting' }],
          websocketAuthorityEnabled: true,
          websocketUrl: 'wss://scraper.example/ws/events',
        }),
      ).success,
    ).to.be.true;
    expect(
      RelayerAgentConfigSchema.safeParse(
        config({
          gasPaymentEnforcement: [{ type: 'onChainFeeQuoting' }],
          websocketAuthorityEnabled: false,
        }),
      ).success,
    ).to.be.true;
  });
});

describe('AgentChainMetadataSchema fallback hedging', () => {
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

  it('parses positive fallback hedge settings', () => {
    const result = AgentChainMetadataSchema.safeParse({
      ...baseChainMetadata,
      rpcConsensusType: RpcConsensusType.Fallback,
      fallbackHedgeDelayMillis: 250,
      fallbackHedgeTimeoutMillis: 30_000,
    });

    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.fallbackHedgeDelayMillis).to.equal(250);
      expect(result.data.fallbackHedgeTimeoutMillis).to.equal(30_000);
    }
  });

  it('rejects zero fallback hedge settings', () => {
    expect(
      AgentChainMetadataSchema.safeParse({
        ...baseChainMetadata,
        fallbackHedgeDelayMillis: 0,
      }).success,
    ).to.be.false;
  });

  it('rejects a timeout without a hedge delay', () => {
    expect(
      AgentChainMetadataSchema.safeParse({
        ...baseChainMetadata,
        fallbackHedgeTimeoutMillis: 30_000,
      }).success,
    ).to.be.false;
  });

  it('rejects fallback hedging with non-fallback RPC consensus', () => {
    expect(
      AgentChainMetadataSchema.safeParse({
        ...baseChainMetadata,
        rpcConsensusType: RpcConsensusType.Single,
        fallbackHedgeDelayMillis: 250,
      }).success,
    ).to.be.false;
  });

  it('rejects fallback hedging without explicit fallback RPC consensus', () => {
    expect(
      AgentChainMetadataSchema.safeParse({
        ...baseChainMetadata,
        fallbackHedgeDelayMillis: 250,
      }).success,
    ).to.be.false;
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

  it('prefers plural process ALT overrides when both keys are present', () => {
    const result = AgentChainMetadataSchema.safeParse({
      ...baseChainMetadata,
      processAltOverrides: [
        {
          matchingList: [{}],
          addressLookupTable: altA,
          addressLookupTables: [altA, altB],
        },
      ],
    });

    expect(result.success).to.equal(true);
    if (result.success) {
      expect(result.data.processAltOverrides).to.deep.equal([
        { matchingList: [{}], addressLookupTables: [altA, altB] },
      ]);
    }
  });

  it('rejects an empty plural override even when the singular key is present', () => {
    expect(
      AgentChainMetadataSchema.safeParse({
        ...baseChainMetadata,
        processAltOverrides: [
          {
            matchingList: [{}],
            addressLookupTable: altA,
            addressLookupTables: [],
          },
        ],
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

describe('ValidatorAgentConfigSchema lightweight mode', () => {
  const config = {
    originChainName: 'test',
    validator: { key: `0x${'11'.repeat(32)}` },
    checkpointSyncer: { type: 'localStorage', path: '/tmp/checkpoints' },
    chains: {
      test: {
        name: 'test',
        domainId: 1337,
        chainId: 1337,
        protocol: ProtocolType.Ethereum,
        rpcUrls: [
          { http: 'https://rpc-a.example' },
          { http: 'https://rpc-b.example' },
          { http: 'https://rpc-c.example' },
        ],
        mailbox: '0x0000000000000000000000000000000000000001',
        interchainGasPaymaster: '0x0000000000000000000000000000000000000002',
        validatorAnnounce: '0x0000000000000000000000000000000000000003',
        merkleTreeHook: '0x0000000000000000000000000000000000000004',
      },
    },
  };

  it('accepts normal quorum and majority for every supported protocol', () => {
    for (const protocol of Object.values(ProtocolType)) {
      for (const rpcConsensusType of [
        RpcConsensusType.Quorum,
        RpcConsensusType.Majority,
      ]) {
        const result = ValidatorAgentConfigSchema.safeParse({
          ...config,
          lightweight: false,
          chains: {
            test: { ...config.chains.test, protocol, rpcConsensusType },
          },
        });
        expect(
          result.success,
          `${protocol}/${rpcConsensusType}: ${result.error?.message}`,
        ).to.be.true;
      }
    }
  });

  it('requires a websocket URL with either spelling', () => {
    for (const flag of ['lightweight', 'leightweigt']) {
      expect(
        ValidatorAgentConfigSchema.safeParse({ ...config, [flag]: true })
          .success,
      ).to.be.false;
      expect(
        ValidatorAgentConfigSchema.safeParse({
          ...config,
          [flag]: true,
          websocketUrl: 'wss://scraper.example/events',
        }).success,
      ).to.be.true;
    }
  });

  it('rejects removed quorum settings in both modes', () => {
    for (const lightweight of [false, true]) {
      for (const removed of [
        { additionalQuorumRpcUrls: [{ http: 'https://quorum.example' }] },
        { additionalQuorumRpcUrls: [] },
        { customAdditionalQuorumRpcUrls: 'https://quorum.example' },
        { customAdditionalQuorumRpcUrls: '' },
      ]) {
        expect(
          ValidatorAgentConfigSchema.safeParse({
            ...config,
            lightweight,
            websocketUrl: 'wss://scraper.example',
            chains: { test: { ...config.chains.test, ...removed } },
          }).success,
        ).to.be.false;
      }
    }
  });

  it('accepts lightweight indexing for every supported protocol', () => {
    for (const protocol of [
      ProtocolType.Ethereum,
      ProtocolType.Sealevel,
      ProtocolType.Cosmos,
      ProtocolType.CosmosNative,
      ProtocolType.Starknet,
      ProtocolType.Radix,
      ProtocolType.Aleo,
      ProtocolType.Tron,
    ]) {
      const result = ValidatorAgentConfigSchema.safeParse({
        ...config,
        lightweight: true,
        websocketUrl: 'wss://scraper.example/events',
        chains: {
          test: {
            ...config.chains.test,
            protocol,
            ...(protocol === ProtocolType.Cosmos ||
            protocol === ProtocolType.CosmosNative
              ? {
                  signer: {
                    type: AgentSignerKeyType.Cosmos,
                    prefix: 'test',
                    key: `0x${'11'.repeat(32)}`,
                  },
                  canonicalAsset: 'utest',
                  gasPrice: { denom: 'utest', amount: '0.025' },
                  contractAddressBytes: 32,
                }
              : {}),
          },
        },
      });
      expect(result.success, `${protocol}: ${result.error?.message}`).to.be
        .true;
    }
  });

  it('rejects conflicting aliases and defaults to classic behavior', () => {
    expect(ValidatorAgentConfigSchema.safeParse(config).success).to.be.true;
    expect(
      ValidatorAgentConfigSchema.safeParse({
        ...config,
        lightweight: true,
        leightweigt: false,
        websocketUrl: 'wss://scraper.example/events',
      }).success,
    ).to.be.false;
  });
});
