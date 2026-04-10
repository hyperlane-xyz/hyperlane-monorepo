import { expect } from 'chai';

import { type IRegistry } from '@hyperlane-xyz/registry';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { createSubmitterReferenceRegistry } from './registry.js';

describe('createSubmitterReferenceRegistry', () => {
  const originalFetch = globalThis.fetch;
  const fetchPayloads = new Map<string, string>();
  let fetchCalls: string[];

  beforeEach(() => {
    fetchPayloads.clear();
    fetchCalls = [];
    globalThis.fetch = async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      fetchCalls.push(url);
      const ok = fetchPayloads.has(url);
      return {
        ok,
        status: ok ? 200 : 404,
        statusText: ok ? 'OK' : 'Not Found',
        text: async () => fetchPayloads.get(url)!,
      } as Response;
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('checks the current registry after child registries miss', async () => {
    fetchPayloads.set(
      'https://registry.example/submitters/dev-ethereum.yaml',
      [
        'type: jsonRpc',
        'chain: ethereum',
        'privateKey: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"',
        '',
      ].join('\n'),
    );

    const registry = createSubmitterReferenceRegistry({
      uri: 'https://registry.example',
      getUri(itemPath?: string) {
        return itemPath
          ? `https://registry.example/${itemPath}`
          : 'https://registry.example';
      },
      registries: [
        {
          uri: 'https://empty.example',
          getUri(itemPath?: string) {
            return itemPath
              ? `https://empty.example/${itemPath}`
              : 'https://empty.example';
          },
        },
      ],
    } as IRegistry & { registries: IRegistry[] });

    const submitter = await registry.getSubmitter?.('submitters/dev-ethereum');

    expect(submitter).to.deep.equal({
      type: TxSubmitterType.JSON_RPC,
      chain: 'ethereum',
      privateKey:
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
  });

  it('does not fetch submitter refs over insecure HTTP by default', async () => {
    fetchPayloads.set(
      'http://registry.example/submitters/dev-ethereum.yaml',
      [
        'type: jsonRpc',
        'chain: ethereum',
        'privateKey: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"',
        '',
      ].join('\n'),
    );

    const registry = createSubmitterReferenceRegistry({
      uri: 'http://registry.example',
      getUri(itemPath?: string) {
        return itemPath
          ? `http://registry.example/${itemPath}`
          : 'http://registry.example';
      },
    } as IRegistry);

    const submitter = await registry.getSubmitter?.('submitters/dev-ethereum');

    expect(submitter).to.equal(null);
    expect(fetchCalls).to.deep.equal([]);
  });

  it('throws on malformed submitter payloads', async () => {
    fetchPayloads.set(
      'https://registry.example/submitters/dev-ethereum.yaml',
      'type: [',
    );

    const registry = createSubmitterReferenceRegistry({
      uri: 'https://registry.example',
      getUri(itemPath?: string) {
        return itemPath
          ? `https://registry.example/${itemPath}`
          : 'https://registry.example';
      },
    } as IRegistry);

    try {
      await registry.getSubmitter?.('submitters/dev-ethereum');
      throw new Error('Expected malformed submitter payload to throw');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Failed to parse submitter reference payload',
      );
    }
  });
});
