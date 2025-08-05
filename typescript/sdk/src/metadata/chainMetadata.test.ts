import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  ChainDisabledReason,
  ChainMetadata,
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
