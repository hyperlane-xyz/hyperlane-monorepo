import { expect } from 'chai';

import { TxSubmitterType } from './TxSubmitterTypes.js';
import {
  resolveSubmissionStrategy,
  resolveSubmitterMetadata,
} from './reference.js';

describe('submitter references', () => {
  const originalFetch = globalThis.fetch;
  const fetchPayloads = new Map<string, string>();

  beforeEach(() => {
    fetchPayloads.clear();
    globalThis.fetch = async (input) => {
      const url = input.toString();
      return {
        ok: fetchPayloads.has(url),
        text: async () => fetchPayloads.get(url)!,
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('resolves submitter metadata from a registry payload', async () => {
    const submitter = await resolveSubmitterMetadata(
      {
        type: 'submitter_ref',
        ref: 'mock://registry/submitters/rebalancer',
      },
      {
        getSubmitter: async () => ({
          type: TxSubmitterType.JSON_RPC,
          chain: 'ethereum',
          userAddress: '0x1111111111111111111111111111111111111111',
          privateKey:
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      },
    );

    expect(submitter).to.deep.equal({
      type: TxSubmitterType.JSON_RPC,
      chain: 'ethereum',
      userAddress: '0x1111111111111111111111111111111111111111',
      privateKey:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('resolves submission strategies from registry payloads', async () => {
    const strategy = await resolveSubmissionStrategy(
      {
        submitter: {
          type: 'submitter_ref',
          ref: 'mock://registry/submitters/rebalancer',
        },
      },
      {
        getSubmitter: async () => ({
          submitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: 'ethereum',
            userAddress: '0x1111111111111111111111111111111111111111',
            privateKey:
              '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        }),
      },
    );

    expect(strategy.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    if (strategy.submitter.type !== TxSubmitterType.JSON_RPC) {
      throw new Error('Expected jsonRpc submitter');
    }
    expect(strategy.submitter.chain).to.equal('ethereum');
    expect(strategy.submitter.privateKey).to.equal(
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
  });

  it('resolves submitter refs from an IRegistry-compatible getUri interface', async () => {
    fetchPayloads.set(
      'https://registry.example/submitters/dev-ethereum.yaml',
      [
        'submitter:',
        '  type: jsonRpc',
        '  chain: ethereum',
        '  privateKey: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"',
        '',
      ].join('\n'),
    );

    const strategy = await resolveSubmissionStrategy(
      {
        submitter: {
          type: 'submitter_ref',
          ref: 'https://registry.example/submitters/dev-ethereum',
        },
      },
      {
        uri: 'https://registry.example',
        getUri(itemPath?: string) {
          return itemPath
            ? `https://registry.example/${itemPath}`
            : 'https://registry.example';
        },
      },
    );

    expect(strategy.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    if (strategy.submitter.type !== TxSubmitterType.JSON_RPC) {
      throw new Error('Expected jsonRpc submitter');
    }
    expect(strategy.submitter.privateKey).to.equal(
      '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    );
  });

  it('resolves submitter refs from merged registries whose getUri throws', async () => {
    fetchPayloads.set(
      'https://registry.example/submitters/dev-ethereum.yaml',
      [
        'type: jsonRpc',
        'chain: ethereum',
        'privateKey: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"',
        '',
      ].join('\n'),
    );

    const strategy = await resolveSubmissionStrategy(
      {
        submitter: {
          type: 'submitter_ref',
          ref: 'https://registry.example/submitters/dev-ethereum',
        },
      },
      {
        uri: '__merged_registry__',
        getUri() {
          throw new Error('getUri method not applicable to MergedRegistry');
        },
        registries: [
          {
            uri: 'https://registry.example',
            getUri(itemPath?: string) {
              return itemPath
                ? `https://registry.example/${itemPath}`
                : 'https://registry.example';
            },
          },
        ],
      },
    );

    expect(strategy.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    if (strategy.submitter.type !== TxSubmitterType.JSON_RPC) {
      throw new Error('Expected jsonRpc submitter');
    }
    expect(strategy.submitter.privateKey).to.equal(
      '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    );
  });
});
