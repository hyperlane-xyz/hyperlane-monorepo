import { expect } from 'vitest';

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
    expect(isValidChainMetadata(minimalSchema)).toBe(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        blockExplorers,
      }),
    ).toBe(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        blockExplorers,
      }),
    ).toBe(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        blockExplorers,
        blocks,
      }),
    ).toBe(true);

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
    ).toBe(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        blocks: {
          confirmations: 1,
          reorgPeriod: EthJsonRpcBlockParameterTag.Finalized,
        },
      }),
    ).toBe(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        availability: {
          status: ChainStatus.Live,
        },
      }),
    ).toBe(true);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        availability: {
          status: ChainStatus.Disabled,
          reasons: [ChainDisabledReason.Deprecated],
        },
      }),
    ).toBe(true);
  });

  it('Rejects invalid schemas', () => {
    expect(
      //@ts-ignore
      isValidChainMetadata({}),
    ).toBe(false);

    //@ts-ignore
    expect(isValidChainMetadata({ ...minimalSchema, chainId: 'id' })).toBe(
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
    ).toBe(false);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        name: 'Invalid name',
      }),
    ).toBe(false);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        chainId: 'string-id',
      }),
    ).toBe(false);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        protocol: ProtocolType.Cosmos,
        chainId: 'string-id',
      }),
    ).toBe(false);

    expect(
      isValidChainMetadata({
        ...minimalSchema,
        availability: {
          status: ChainStatus.Disabled,
          reasons: [],
        },
      }),
    ).toBe(false);
  });
});
