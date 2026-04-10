import { expect } from 'chai';

import { type IRegistry } from '@hyperlane-xyz/registry';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { extendRegistryWithSubmitters } from './service.js';

describe('extendRegistryWithSubmitters', () => {
  const originalFetch = globalThis.fetch;
  const fetchPayloads = new Map<string, string>();

  beforeEach(() => {
    fetchPayloads.clear();
    globalThis.fetch = async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
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

  it('prefers later child registries over earlier child registries', async () => {
    fetchPayloads.set(
      'https://github.example/submitters/dev-ethereum.yaml',
      [
        'type: jsonRpc',
        'chain: ethereum',
        'privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        '',
      ].join('\n'),
    );
    fetchPayloads.set(
      'https://local.example/submitters/dev-ethereum.yaml',
      [
        'type: jsonRpc',
        'chain: ethereum',
        'privateKey: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"',
        '',
      ].join('\n'),
    );

    const registry = extendRegistryWithSubmitters({
      uri: '__merged_registry__',
      getUri() {
        throw new Error('getUri method not applicable to MergedRegistry');
      },
      registries: [
        {
          uri: 'https://github.example',
          getUri(itemPath?: string) {
            return itemPath
              ? `https://github.example/${itemPath}`
              : 'https://github.example';
          },
        },
        {
          uri: 'https://local.example',
          getUri(itemPath?: string) {
            return itemPath
              ? `https://local.example/${itemPath}`
              : 'https://local.example';
          },
        },
      ],
    } as unknown as IRegistry & { registries: IRegistry[] });

    const submitter = await registry.getSubmitter?.('submitters/dev-ethereum');

    expect(submitter).to.deep.equal({
      type: TxSubmitterType.JSON_RPC,
      chain: 'ethereum',
      privateKey:
        '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    });
  });

  it('throws on malformed local submitter refs', async () => {
    const registry = extendRegistryWithSubmitters({
      uri: 'https://registry.example',
      getUri(itemPath?: string) {
        return itemPath
          ? `https://registry.example/${itemPath}`
          : 'https://registry.example';
      },
    } as IRegistry);

    try {
      await registry.getSubmitter?.('chains/ethereum');
      throw new Error('Expected malformed submitter ref to throw');
    } catch (error) {
      expect((error as Error).message).to.include(
        'must target a top-level submitters/ entry',
      );
    }
  });
});
