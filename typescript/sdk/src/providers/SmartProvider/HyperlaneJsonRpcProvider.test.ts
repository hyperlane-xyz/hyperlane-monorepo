import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import sinon from 'sinon';

import { assert } from '@hyperlane-xyz/utils';

import type { RpcUrl } from '../../metadata/chainMetadataTypes.js';

import { ProviderMethod } from './ProviderMethods.js';
import {
  HyperlaneJsonRpcProvider,
  LogBlockHistoryUnavailableError,
  LogBlockRangeTooLargeError,
} from './HyperlaneJsonRpcProvider.js';
import type { HyperlaneLogFilter } from './types.js';

const LATEST_BLOCK = 100;
const FILTER_ADDRESS = '0x0000000000000000000000000000000000000001';

interface BlockWindowCase {
  name: string;
  pagination: RpcUrl['pagination'];
  fromBlock: number;
  toBlock: number | 'latest';
  expected: Array<[number, number]>;
}

interface HistoryFloorCase {
  name: string;
  pagination: RpcUrl['pagination'];
  fromBlock: number;
  toBlock: number | 'latest';
  expectedMessage: string;
}

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

  describe('the sub-query work bound', () => {
    it('serves a span sitting exactly on the bound', async () => {
      const served = stubBlockWindows();
      const provider = new HyperlaneJsonRpcProvider(
        { http: 'http://provider', pagination: { maxBlockRange: 2 } },
        { chainId: 1, name: 'test' },
      );

      await provider.getLogs({
        address: FILTER_ADDRESS,
        fromBlock: 0,
        toBlock: 19,
      });

      expect(served).to.deep.equal([
        [0, 1],
        [2, 3],
        [4, 5],
        [6, 7],
        [8, 9],
        [10, 11],
        [12, 13],
        [14, 15],
        [16, 17],
        [18, 19],
      ]);
    });

    // The span used to be answered over its last ten sub-queries, with nothing
    // in the response marking the blocks below that had been dropped.
    it('rejects a span one sub-query above the bound without querying', async () => {
      const served = stubBlockWindows();
      const provider = new HyperlaneJsonRpcProvider(
        { http: 'http://provider', pagination: { maxBlockRange: 2 } },
        { chainId: 1, name: 'test' },
      );

      const error = await captureRejection(
        provider.getLogs({
          address: FILTER_ADDRESS,
          fromBlock: 0,
          toBlock: 21,
        }),
      );

      expect(error).to.be.instanceOf(LogBlockRangeTooLargeError);
      assert(error instanceof Error, 'Expected the rejection to be an Error');
      expect(error.message).to.equal(
        'Serving blocks 0 to 21 needs 11 queries at a block range of 2, above the 10 this provider issues for one request',
      );
      expect(served).to.deep.equal([]);
    });

    // Halving recovers from the bound but never from a floor, so a request
    // below both has to be reported as the floor: a caller told it asked for
    // too wide a span would shrink its chunks all the way to one block and
    // still be below the history this endpoint holds.
    it('reports the history floor rather than the bound when a request is below both', async () => {
      const served = stubBlockWindows(5_001);
      const provider = new HyperlaneJsonRpcProvider(
        {
          http: 'http://provider',
          pagination: { maxBlockRange: 1, minBlockNumber: 5_000 },
        },
        { chainId: 1, name: 'test' },
      );

      const error = await captureRejection(
        provider.getLogs({
          address: FILTER_ADDRESS,
          fromBlock: 0,
          toBlock: 'latest',
        }),
      );

      expect(error).to.be.instanceOf(LogBlockHistoryUnavailableError);
      assert(error instanceof Error, 'Expected the rejection to be an Error');
      expect(error.message).to.equal(
        'Blocks 0 to 5001 were requested, but this provider serves no block below 5000',
      );
      expect(served).to.deep.equal([]);
    });
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

  describe('block windows within the queryable bound', () => {
    const cases: BlockWindowCase[] = [
      {
        name: 'splits an exact multiple of maxBlockRange into equal windows',
        pagination: { maxBlockRange: 5 },
        fromBlock: 76,
        toBlock: 100,
        expected: [
          [76, 80],
          [81, 85],
          [86, 90],
          [91, 95],
          [96, 100],
        ],
      },
      {
        name: 'leaves the final window short when the span is not a multiple',
        pagination: { maxBlockRange: 5 },
        fromBlock: 74,
        toBlock: 100,
        expected: [
          [74, 78],
          [79, 83],
          [84, 88],
          [89, 93],
          [94, 98],
          [99, 100],
        ],
      },
      {
        name: 'serves a span sitting exactly on the maxBlockRange bound in full',
        pagination: { maxBlockRange: 5 },
        fromBlock: 51,
        toBlock: 100,
        expected: [
          [51, 55],
          [56, 60],
          [61, 65],
          [66, 70],
          [71, 75],
          [76, 80],
          [81, 85],
          [86, 90],
          [91, 95],
          [96, 100],
        ],
      },
      {
        name: 'serves a span narrower than maxBlockRange as a single window',
        pagination: { maxBlockRange: 5 },
        fromBlock: 98,
        toBlock: 100,
        expected: [[98, 100]],
      },
      {
        name: 'serves a single block span as a single window',
        pagination: { maxBlockRange: 5 },
        fromBlock: 100,
        toBlock: 100,
        expected: [[100, 100]],
      },
      {
        name: 'resolves a latest toBlock to the current block number',
        pagination: { maxBlockRange: 5 },
        fromBlock: 96,
        toBlock: 'latest',
        expected: [[96, 100]],
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        const served = stubBlockWindows();
        const provider = new HyperlaneJsonRpcProvider(
          { http: 'http://provider', pagination: testCase.pagination },
          { chainId: 1, name: 'test' },
        );

        await provider.getLogs({
          address: FILTER_ADDRESS,
          fromBlock: testCase.fromBlock,
          toBlock: testCase.toBlock,
        });

        expect(served).to.deep.equal(testCase.expected);
      });
    }
  });

  // Each of these used to be answered by raising the start block to the floor
  // and returning the logs of the remaining window, with nothing in the
  // response marking the blocks below that had been dropped.
  describe('start block floors', () => {
    const refusedCases: HistoryFloorCase[] = [
      {
        name: 'refuses a start block below minBlockNumber',
        pagination: { maxBlockRange: 5, minBlockNumber: 90 },
        fromBlock: 60,
        toBlock: 100,
        expectedMessage:
          'Blocks 60 to 100 were requested, but this provider serves no block below 90',
      },
      {
        name: 'refuses a start block below minBlockNumber without maxBlockRange',
        pagination: { minBlockNumber: 90 },
        fromBlock: 0,
        toBlock: 100,
        expectedMessage:
          'Blocks 0 to 100 were requested, but this provider serves no block below 90',
      },
      {
        name: 'refuses a start block below the maxBlockAge floor',
        pagination: { maxBlockRange: 5, maxBlockAge: 20 },
        fromBlock: 60,
        toBlock: 100,
        expectedMessage:
          'Blocks 60 to 100 were requested, but at block height 100 a max block age of 20 leaves this provider serving no block below 80',
      },
      {
        name: 'measures maxBlockAge from the chain head, not the requested toBlock',
        pagination: { maxBlockRange: 5, maxBlockAge: 20 },
        fromBlock: 60,
        toBlock: 90,
        expectedMessage:
          'Blocks 60 to 90 were requested, but at block height 100 a max block age of 20 leaves this provider serving no block below 80',
      },
      {
        // The start block clears the age floor of 80, so only the higher of the
        // two floors refuses this one.
        name: 'refuses a start block below minBlockNumber but above the maxBlockAge floor',
        pagination: { maxBlockRange: 5, maxBlockAge: 20, minBlockNumber: 95 },
        fromBlock: 85,
        toBlock: 100,
        expectedMessage:
          'Blocks 85 to 100 were requested, but this provider serves no block below 95',
      },
      {
        // Below both floors. The age floor of 80 is the one checked first but
        // not the one the provider starts at, and naming it would have a caller
        // raise its start block to 80 only to be refused again at 95.
        name: 'names the higher floor when the start block is below both',
        pagination: { maxBlockRange: 5, maxBlockAge: 20, minBlockNumber: 95 },
        fromBlock: 60,
        toBlock: 100,
        expectedMessage:
          'Blocks 60 to 100 were requested, but this provider serves no block below 95',
      },
      {
        // Below both floors with the age floor of 80 the higher of the two, so
        // the same rule reports the age floor rather than minBlockNumber.
        name: 'names the maxBlockAge floor when it sits above minBlockNumber',
        pagination: { maxBlockRange: 5, maxBlockAge: 20, minBlockNumber: 70 },
        fromBlock: 60,
        toBlock: 100,
        expectedMessage:
          'Blocks 60 to 100 were requested, but at block height 100 a max block age of 20 leaves this provider serving no block below 80',
      },
    ];

    for (const testCase of refusedCases) {
      it(testCase.name, async () => {
        const served = stubBlockWindows();
        const provider = new HyperlaneJsonRpcProvider(
          { http: 'http://provider', pagination: testCase.pagination },
          { chainId: 1, name: 'test' },
        );

        const error = await captureRejection(
          provider.getLogs({
            address: FILTER_ADDRESS,
            fromBlock: testCase.fromBlock,
            toBlock: testCase.toBlock,
          }),
        );

        expect(error).to.be.instanceOf(LogBlockHistoryUnavailableError);
        assert(error instanceof Error, 'Expected the rejection to be an Error');
        expect(error.message).to.equal(testCase.expectedMessage);
        expect(served).to.deep.equal([]);
      });
    }

    const servedCases: BlockWindowCase[] = [
      {
        name: 'serves a request starting exactly at minBlockNumber',
        pagination: { maxBlockRange: 5, minBlockNumber: 90 },
        fromBlock: 90,
        toBlock: 100,
        expected: [
          [90, 94],
          [95, 99],
          [100, 100],
        ],
      },
      {
        name: 'serves a request starting exactly at the maxBlockAge floor',
        pagination: { maxBlockRange: 5, maxBlockAge: 20 },
        fromBlock: 80,
        toBlock: 100,
        expected: [
          [80, 84],
          [85, 89],
          [90, 94],
          [95, 99],
          [100, 100],
        ],
      },
      {
        name: 'serves a request starting above both floors',
        pagination: { maxBlockRange: 5, maxBlockAge: 20, minBlockNumber: 90 },
        fromBlock: 90,
        toBlock: 100,
        expected: [
          [90, 94],
          [95, 99],
          [100, 100],
        ],
      },
      {
        name: 'serves the whole span as one window without maxBlockRange',
        pagination: { minBlockNumber: 90 },
        fromBlock: 90,
        toBlock: 100,
        expected: [[90, 100]],
      },
      {
        // The chunk size without maxBlockRange is the span itself, which a
        // single block request leaves at zero unless the span is counted
        // inclusively: the window loop would then never advance past it.
        name: 'serves a single block span without maxBlockRange',
        pagination: { minBlockNumber: 90 },
        fromBlock: 95,
        toBlock: 95,
        expected: [[95, 95]],
      },
    ];

    for (const testCase of servedCases) {
      it(testCase.name, async () => {
        const served = stubBlockWindows();
        const provider = new HyperlaneJsonRpcProvider(
          { http: 'http://provider', pagination: testCase.pagination },
          { chainId: 1, name: 'test' },
        );

        await provider.getLogs({
          address: FILTER_ADDRESS,
          fromBlock: testCase.fromBlock,
          toBlock: testCase.toBlock,
        });

        expect(served).to.deep.equal(testCase.expected);
      });
    }
  });

  it('issues sub-queries five at a time', async () => {
    const started: Array<[number, number]> = [];
    const gates: Array<() => void> = [];
    sinon
      .stub(providers.JsonRpcProvider.prototype, 'perform')
      .callsFake(
        async (
          method: string,
          params: { filter?: { fromBlock?: unknown; toBlock?: unknown } },
        ) => {
          if (method === ProviderMethod.GetBlockNumber) return LATEST_BLOCK;
          if (method !== ProviderMethod.GetLogs) {
            throw new Error(`Unexpected method ${method}`);
          }
          if (!params.filter) throw new Error('Missing log filter');
          started.push(decodeBlockWindow(params.filter));
          await new Promise<void>((resolve) => gates.push(resolve));
          return [];
        },
      );
    const provider = new HyperlaneJsonRpcProvider(
      { http: 'http://provider', pagination: { maxBlockRange: 5 } },
      { chainId: 1, name: 'test' },
    );

    // Seven windows: five are issued together, the remaining two only once the
    // first batch has fully resolved.
    const logs = provider.getLogs({
      address: FILTER_ADDRESS,
      fromBlock: 66,
      toBlock: 100,
    });

    await drainPendingWork();
    expect(started).to.deep.equal([
      [66, 70],
      [71, 75],
      [76, 80],
      [81, 85],
      [86, 90],
    ]);

    releaseAll(gates);
    await drainPendingWork();
    expect(started).to.deep.equal([
      [66, 70],
      [71, 75],
      [76, 80],
      [81, 85],
      [86, 90],
      [91, 95],
      [96, 100],
    ]);

    releaseAll(gates);
    expect(await logs).to.deep.equal([]);
  });
});

function decodeBlockWindow(filter: {
  fromBlock?: unknown;
  toBlock?: unknown;
}): [number, number] {
  const { fromBlock, toBlock } = filter;
  assert(
    typeof fromBlock === 'string',
    `Expected a hex fromBlock, got ${typeof fromBlock}`,
  );
  assert(
    typeof toBlock === 'string',
    `Expected a hex toBlock, got ${typeof toBlock}`,
  );
  return [
    BigNumber.from(fromBlock).toNumber(),
    BigNumber.from(toBlock).toNumber(),
  ];
}

// Records the block windows the JSON-RPC transport was actually asked to serve.
function stubBlockWindows(
  latestBlock: number = LATEST_BLOCK,
): Array<[number, number]> {
  const served: Array<[number, number]> = [];
  sinon
    .stub(providers.JsonRpcProvider.prototype, 'perform')
    .callsFake(
      async (
        method: string,
        params: { filter?: { fromBlock?: unknown; toBlock?: unknown } },
      ) => {
        if (method === ProviderMethod.GetBlockNumber) return latestBlock;
        if (method !== ProviderMethod.GetLogs) {
          throw new Error(`Unexpected method ${method}`);
        }
        if (!params.filter) throw new Error('Missing log filter');
        served.push(decodeBlockWindow(params.filter));
        return [];
      },
    );
  return served;
}

// Resolves after the microtask queue has drained, so every sub-query the
// provider was going to issue without further input has been issued.
function drainPendingWork(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function releaseAll(gates: Array<() => void>): void {
  for (const release of gates.splice(0)) release();
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.fail('Expected promise to reject');
}

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
