import { expect } from 'chai';

import { type IRegistry } from '@hyperlane-xyz/registry';
import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { extendRegistryWithSubmitters } from '../../src/services/rootService.js';

describe('extendRegistryWithSubmitters', () => {
  const originalFetch = globalThis.fetch;
  const fetchPayloads = new Map<string, string>();
  let fetchHeaders: Array<Record<string, string> | undefined>;

  beforeEach(() => {
    fetchPayloads.clear();
    fetchHeaders = [];
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      fetchHeaders.push(init?.headers as Record<string, string> | undefined);
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

  it('forwards auth tokens for remote submitter refs', async () => {
    fetchPayloads.set(
      'https://registry.example/submitters/dev-ethereum.yaml',
      [
        'type: jsonRpc',
        'chain: ethereum',
        'privateKey: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"',
        '',
      ].join('\n'),
    );

    const registry = extendRegistryWithSubmitters(
      {
        uri: 'https://registry.example',
        getUri(itemPath?: string) {
          return itemPath
            ? `https://registry.example/${itemPath}`
            : 'https://registry.example';
        },
      } as IRegistry,
      'secret-token',
    );

    const submitter = await registry.getSubmitter?.('submitters/dev-ethereum');

    expect(submitter).to.deep.equal({
      type: TxSubmitterType.JSON_RPC,
      chain: 'ethereum',
      privateKey:
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    expect(fetchHeaders).to.deep.equal([
      { Authorization: 'Bearer secret-token' },
      { Authorization: 'Bearer secret-token' },
    ]);
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
