import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import sinon from 'sinon';

import { ProviderMethod } from './ProviderMethods.js';
import { HyperlaneJsonRpcProvider } from './HyperlaneJsonRpcProvider.js';
import type { HyperlaneLogFilter } from './types.js';

describe('HyperlaneJsonRpcProvider', () => {
  afterEach(() => sinon.restore());

  it('normalizes generated multi-address filters for JSON-RPC transport', () => {
    const provider = new HyperlaneJsonRpcProvider(
      { http: 'http://provider' },
      { chainId: 1, name: 'test' },
    );
    const addresses = Array.from({ length: 25 }, (_, index) => {
      const address = utils.getAddress(
        utils.hexZeroPad(
          BigNumber.from(index + 1)
            .mul(0xabcdef)
            .toHexString(),
          20,
        ),
      );
      return index % 2 === 0 ? address : address.toLowerCase();
    });

    for (let size = 1; size <= 5; size += 1) {
      for (let offset = 0; offset + size <= addresses.length; offset += size) {
        const cohort = addresses.slice(offset, offset + size);
        const [method, params] = provider.prepareRequest(
          ProviderMethod.GetLogs,
          {
            filter: { address: cohort },
          },
        );

        expect(method).to.equal('eth_getLogs');
        expect(params[0].address).to.deep.equal(
          cohort.map((address) => address.toLowerCase()),
        );
      }
    }
  });

  it('validates and deduplicates direct multi-address transport requests', () => {
    const provider = new HyperlaneJsonRpcProvider(
      { http: 'http://provider' },
      { chainId: 1, name: 'test' },
    );
    const readonlyAddresses: readonly string[] = [
      '0x00000000000000000000000000000000000000aa',
      '0x00000000000000000000000000000000000000AA',
    ];

    const [, params] = provider.prepareRequest(ProviderMethod.GetLogs, {
      filter: { address: readonlyAddresses },
    });

    expect(params[0].address).to.deep.equal([
      '0x00000000000000000000000000000000000000aa',
    ]);
    expect(() =>
      provider.prepareRequest(ProviderMethod.GetLogs, {
        filter: { address: [] },
      }),
    ).to.throw('Multi-address log filters require at least one address');
    expect(() =>
      provider.prepareRequest(ProviderMethod.GetLogs, {
        filter: { address: [readonlyAddresses[0], 7] },
      }),
    ).to.throw('Multi-address log filters require valid addresses');
    expect(() =>
      provider.prepareRequest(ProviderMethod.GetLogs, {
        filter: { address: [readonlyAddresses[0], 'not-an-address'] },
      }),
    ).to.throw('invalid address');
  });

  it('preserves the complete address array across pagination chunks', async () => {
    const addresses = [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
    ];
    const filters: Array<
      Omit<providers.Filter, 'address'> & {
        address?: string | readonly string[];
      }
    > = [];
    sinon.stub(providers.JsonRpcProvider.prototype, 'perform').callsFake(
      async (
        method: string,
        params: {
          filter?: Omit<providers.Filter, 'address'> & {
            address?: string | readonly string[];
          };
        },
      ) => {
        if (method === ProviderMethod.GetBlockNumber) return 20;
        if (method === ProviderMethod.GetLogs) {
          if (!params.filter) throw new Error('Missing log filter');
          filters.push(params.filter);
          return [];
        }
        throw new Error(`Unexpected method ${method}`);
      },
    );
    const provider = new HyperlaneJsonRpcProvider(
      { http: 'http://provider', pagination: { maxBlockRange: 2 } },
      { chainId: 1, name: 'test' },
    );

    const filterAddresses: readonly string[] = [...addresses, addresses[0]];
    await provider.getLogs({
      address: filterAddresses,
      fromBlock: 1,
      toBlock: 6,
      topics: [utils.id('Transfer(address,address,uint256)')],
    });

    expect(filters).to.have.length(3);
    expect(filters.map((filter) => filter.address)).to.deep.equal([
      addresses,
      addresses,
      addresses,
    ]);
    expect(
      filters.map((filter) => [filter.fromBlock, filter.toBlock]),
    ).to.deep.equal([
      ['0x1', '0x2'],
      ['0x3', '0x4'],
      ['0x5', '0x6'],
    ]);
  });

  it('preserves blockHash filters without pagination', async () => {
    const addresses: readonly string[] = [
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
    ];
    const blockHash = `0x${'a'.repeat(64)}`;
    const requests: HyperlaneLogFilter[] = [];
    sinon
      .stub(providers.JsonRpcProvider.prototype, 'perform')
      .callsFake(
        async (method: string, params: { filter?: HyperlaneLogFilter }) => {
          if (method !== ProviderMethod.GetLogs) {
            throw new Error(`Unexpected method ${method}`);
          }
          if (!params.filter) throw new Error('Missing log filter');
          requests.push(params.filter);
          return [];
        },
      );
    const provider = new HyperlaneJsonRpcProvider(
      { http: 'http://provider', pagination: { maxBlockRange: 2 } },
      { chainId: 1, name: 'test' },
    );

    await provider.getLogs({ address: addresses, blockHash });

    expect(requests).to.deep.equal([
      {
        address: addresses,
        blockHash,
      },
    ]);
  });

  it('rejects empty and invalid multi-address filters before transport', async () => {
    const perform = sinon.stub(providers.JsonRpcProvider.prototype, 'perform');
    const provider = new HyperlaneJsonRpcProvider(
      { http: 'http://provider' },
      { chainId: 1, name: 'test' },
    );

    await expectRejection(
      provider.getLogs({ address: [] }),
      'Multi-address log filters require at least one address',
    );
    await expectRejection(
      provider.getLogs({
        address: [
          '0x0000000000000000000000000000000000000001',
          'not-an-address',
        ],
      }),
      'invalid address',
    );
    expect(perform.called).to.be.false;
  });
});

async function expectRejection(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await promise;
    expect.fail('Expected promise to reject');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.message).to.include(message);
  }
}
