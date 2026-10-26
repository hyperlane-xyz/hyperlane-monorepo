import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  ChainDisabledReason,
  ChainMetadata,
  ChainMetadataSchema,
  RadixChainMetadataSchemaObject,
  ChainStatus,
  EthJsonRpcBlockParameterTag,
  isValidChainMetadata,
} from './chainMetadataTypes.js';

const minimalSchema: ChainMetadata = {
  chainId: 5,
  domainId: 5,
  name: 'sepolia',
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'https://foobar.com' }],
};

const blockExplorers = [
  {
    name: 'scan',
    url: 'https://foobar.com',
    apiUrl: 'https://api.foobar.com',
  },
];

const blocks = {
  confirmations: 1,
  estimateBlockTime: 10,
};

describe('ChainMetadataSchema', () => {
  it('accepts Radix with a public Gateway and explicitly private Core RPCs', () => {
    const metadata = {
      ...minimalSchema,
      protocol: ProtocolType.Radix,
      rpcUrls: [],
      gatewayUrls: [{ http: 'https://mainnet.radixdlt.com' }],
      mailbox: 'retained-extension',
    };
    expect(ChainMetadataSchema.parse(metadata)).to.deep.equal(metadata);
    expect(RadixChainMetadataSchemaObject.safeParse(metadata).success).to.equal(
      true,
    );
  });

  it('rejects empty Core RPCs without a usable Radix Gateway', () => {
    for (const gatewayUrls of [undefined, [], [{ http: 'invalid' }]]) {
      expect(
        isValidChainMetadata({
          ...minimalSchema,
          protocol: ProtocolType.Radix,
          rpcUrls: [],
          gatewayUrls,
        }),
      ).to.equal(false);
    }
  });

  it('continues requiring RPCs for other protocols even if a Gateway is supplied', () => {
    for (const protocol of [ProtocolType.Ethereum, ProtocolType.Sealevel]) {
      expect(
        isValidChainMetadata({
          ...minimalSchema,
          protocol,
          rpcUrls: [],
          gatewayUrls: [{ http: 'https://mainnet.radixdlt.com' }],
        }),
      ).to.equal(false);
    }
  });

  it('validates independent v1 read and sending capabilities', () => {
    const metadata = { ...minimalSchema, protocol: ProtocolType.Sealevel };
    expect(
      isValidChainMetadata({ ...metadata, maxSupportedTransactionVersion: 1 }),
    ).to.equal(true);
    expect(
      isValidChainMetadata({ ...metadata, sealevelTransactionVersion: 1 }),
    ).to.equal(false);
    expect(
      isValidChainMetadata({
        ...metadata,
        sealevelTransactionVersion: 1,
        maxSupportedTransactionVersion: 0,
      }),
    ).to.equal(false);
    expect(
      isValidChainMetadata({
        ...metadata,
        sealevelV1TransactionsEnabled: true,
      }),
    ).to.equal(false);
    expect(
      isValidChainMetadata({
        ...metadata,
        sealevelV1TransactionsEnabled: true,
        maxSupportedTransactionVersion: 1,
      }),
    ).to.equal(true);
    expect(
      isValidChainMetadata({
        ...metadata,
        sealevelV1TransactionsEnabled: true,
        maxSupportedTransactionVersion: 1,
        sealevelTransactionVersion: 1,
      }),
    ).to.equal(true);
  });

  it('Accepts valid schemas', () => {
    expect(isValidChainMetadata(minimalSchema)).to.eq(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        blockExplorers,
      }),
    ).to.eq(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        blockExplorers,
      }),
    ).to.eq(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        blockExplorers,
        blocks,
      }),
    ).to.eq(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        protocol: ProtocolType.Cosmos,
        chainId: 'cosmos',
        bech32Prefix: 'cosmos',
        slip44: 118,
        restUrls: [],
        grpcUrls: [],
      }),
    ).to.eq(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        blocks: {
          confirmations: 1,
          reorgPeriod: EthJsonRpcBlockParameterTag.Finalized,
        },
      }),
    ).to.eq(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        availability: {
          status: ChainStatus.Live,
        },
      }),
    ).to.eq(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        availability: {
          status: ChainStatus.Disabled,
          reasons: [ChainDisabledReason.Deprecated],
        },
      }),
    ).to.eq(true);
  });

  it('Rejects invalid schemas', () => {
    expect(
      //@ts-ignore
      isValidChainMetadata({}),
    ).to.eq(false);

    //@ts-ignore
    expect(isValidChainMetadata({ ...minimalSchema, chainId: 'id' })).to.eq(
      false,
    );

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        blockExplorers: [
          {
            ...blockExplorers[0],
            apiUrl: 'not-a-url',
          },
        ],
      }),
    ).to.eq(false);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        name: 'Invalid name',
      }),
    ).to.eq(false);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        chainId: 'string-id',
      }),
    ).to.eq(false);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        protocol: ProtocolType.Cosmos,
        chainId: 'string-id',
      }),
    ).to.eq(false);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        availability: {
          status: ChainStatus.Disabled,
          reasons: [],
        },
      }),
    ).to.eq(false);
  });
});
