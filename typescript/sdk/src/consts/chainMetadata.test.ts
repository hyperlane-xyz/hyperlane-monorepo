import { expect } from 'chai';

import { ChainMetadata, isValidChainMetadata } from './chainMetadata';

const minimalSchema: ChainMetadata = {
  chainId: 5,
  name: 'goerli',
  publicRpcUrls: [{ http: 'https://foobar.com' }],
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
  });
});
