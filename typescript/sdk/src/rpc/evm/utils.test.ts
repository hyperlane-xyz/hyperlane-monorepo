import { expect } from 'chai';
import { BigNumber, providers, utils } from 'ethers';
import sinon from 'sinon';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { LogBlockRangeTooLargeError } from '../../providers/SmartProvider/HyperlaneJsonRpcProvider.js';
import { ProviderMethod } from '../../providers/SmartProvider/ProviderMethods.js';

import {
  getLogsFromRpc,
  isBlockRangeError,
  isTerminalLogReadError,
} from './utils.js';

const CHAIN_NAME = 'paginatedchain';
const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000abc';
const TRANSFER_TOPIC = utils.id('Transfer(address,address,uint256)');
const LATEST_BLOCK_NUMBER = 1_000;

function chainMetadata(maxBlockRange?: number): ChainMetadata {
  return {
    chainId: 31_337_000,
    domainId: 31_337_000,
    name: CHAIN_NAME,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [
      {
        http: 'http://provider',
        pagination: maxBlockRange === undefined ? undefined : { maxBlockRange },
      },
    ],
  };
}

type ServedRange = { fromBlock: number; toBlock: number };

function toBlockNumber(blockTag: unknown, field: string): number {
  expect(blockTag, `Expected a ${field} block tag`).to.be.a('string');
  if (typeof blockTag !== 'string') {
    throw new Error(`Expected a ${field} block tag, got ${typeof blockTag}`);
  }
  return BigNumber.from(blockTag).toNumber();
}

describe('rpc/evm/utils', () => {
  afterEach(() => sinon.restore());

  // Records the block ranges the JSON-RPC transport was actually asked to
  // serve, which is what HyperlaneJsonRpcProvider splits a requested chunk into
  // when the RPC declares a maxBlockRange narrower than the chunk.
  function stubTransport(): ServedRange[] {
    const served: ServedRange[] = [];

    sinon
      .stub(providers.JsonRpcProvider.prototype, 'perform')
      .callsFake(async (method: string, params: { filter?: unknown }) => {
        if (method === ProviderMethod.GetBlockNumber) {
          return LATEST_BLOCK_NUMBER;
        }
        if (method !== ProviderMethod.GetLogs) {
          throw new Error(`Unexpected method ${method}`);
        }

        const filter = params.filter;
        if (typeof filter !== 'object' || filter === null) {
          throw new Error('Missing log filter');
        }
        served.push({
          fromBlock: toBlockNumber(Reflect.get(filter, 'fromBlock'), 'from'),
          toBlock: toBlockNumber(Reflect.get(filter, 'toBlock'), 'to'),
        });
        return [];
      });

    return served;
  }

  // The chunks getLogsFromRpc asked the provider for, as opposed to the
  // narrower ones the provider then split them into for the transport.
  function requestedChunks(getLogs: sinon.SinonSpy): ServedRange[] {
    return getLogs.getCalls().map((call) => {
      const filter: unknown = call.args[0];
      if (typeof filter !== 'object' || filter === null) {
        throw new Error('Expected getLogsFromRpc to pass a log filter object');
      }
      const fromBlock: unknown = Reflect.get(filter, 'fromBlock');
      const toBlock: unknown = Reflect.get(filter, 'toBlock');
      if (typeof fromBlock !== 'number' || typeof toBlock !== 'number') {
        throw new Error('Expected numeric block bounds on the log filter');
      }
      return { fromBlock, toBlock };
    });
  }

  // Every block between fromBlock and toBlock must appear in exactly one served
  // range, otherwise the scan reported logs for a window it never read.
  function expectFullCoverage(
    served: ServedRange[],
    fromBlock: number,
    toBlock: number,
  ): void {
    const ordered = [...served].sort((a, b) => a.fromBlock - b.fromBlock);
    expect(ordered).to.have.length.greaterThan(0);
    expect(ordered[0].fromBlock).to.equal(fromBlock);
    expect(ordered[ordered.length - 1].toBlock).to.equal(toBlock);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].fromBlock).to.equal(ordered[i - 1].toBlock + 1);
    }
  }

  describe(getLogsFromRpc.name, () => {
    // A chunk wider than the RPC's declared maxBlockRange is split by the
    // transport rather than narrowed, so every block of it is read even though
    // this loop only ever sees one chunk.
    it('never lets the transport narrow a chunk it requested', async () => {
      const served = stubTransport();
      const multiProvider = new MultiProvider({
        [CHAIN_NAME]: chainMetadata(2),
      });

      await getLogsFromRpc({
        chain: CHAIN_NAME,
        contractAddress: CONTRACT_ADDRESS,
        multiProvider,
        fromBlock: 0,
        toBlock: 39,
        topic: TRANSFER_TOPIC,
        range: 1_000,
      });

      expectFullCoverage(served, 0, 39);
      const widestServed = Math.max(
        ...served.map(({ fromBlock, toBlock }) => toBlock - fromBlock + 1),
      );
      expect(widestServed).to.equal(2);
    });

    it('clamps the final chunk to the end block', async () => {
      const served = stubTransport();
      const multiProvider = new MultiProvider({
        [CHAIN_NAME]: chainMetadata(),
      });

      await getLogsFromRpc({
        chain: CHAIN_NAME,
        contractAddress: CONTRACT_ADDRESS,
        multiProvider,
        fromBlock: 0,
        toBlock: 39,
        topic: TRANSFER_TOPIC,
        range: 1_000,
      });

      expect(served).to.deep.equal([{ fromBlock: 0, toBlock: 39 }]);
    });

    it('requests chunks spanning exactly the configured range', async () => {
      const served = stubTransport();
      const multiProvider = new MultiProvider({
        [CHAIN_NAME]: chainMetadata(1_000),
      });

      await getLogsFromRpc({
        chain: CHAIN_NAME,
        contractAddress: CONTRACT_ADDRESS,
        multiProvider,
        fromBlock: 0,
        toBlock: 39,
        topic: TRANSFER_TOPIC,
        range: 20,
      });

      expect(served).to.deep.equal([
        { fromBlock: 0, toBlock: 19 },
        { fromBlock: 20, toBlock: 39 },
      ]);
    });

    // The transport refuses a chunk it would have to split into more than 2000
    // sub-queries. That refusal has to reach the halving ladder, otherwise a
    // caller asking for a wide range on an RPC declaring a narrow one fails
    // outright instead of completing at a smaller chunk size.
    it('halves the range when the transport refuses its own sub-query bound', async () => {
      const served = stubTransport();
      const multiProvider = new MultiProvider({
        [CHAIN_NAME]: chainMetadata(1),
      });
      const getLogs = sinon.spy(
        multiProvider.getProvider(CHAIN_NAME),
        'getLogs',
      );

      await getLogsFromRpc({
        chain: CHAIN_NAME,
        contractAddress: CONTRACT_ADDRESS,
        multiProvider,
        fromBlock: 0,
        toBlock: 2_000,
        topic: TRANSFER_TOPIC,
        range: 2_001,
      });

      expect(requestedChunks(getLogs)).to.deep.equal([
        { fromBlock: 0, toBlock: 2_000 },
        { fromBlock: 0, toBlock: 999 },
        { fromBlock: 1_000, toBlock: 1_999 },
        { fromBlock: 2_000, toBlock: 2_000 },
      ]);
      expectFullCoverage(served, 0, 2_000);
    });
  });

  describe(isBlockRangeError.name, () => {
    interface ClassificationCase {
      name: string;
      error: unknown;
      expected: boolean;
    }

    const cases: ClassificationCase[] = [
      {
        name: 'infura result cap',
        error: new Error('query returned more than 10000 results'),
        expected: true,
      },
      {
        name: 'alchemy response size cap',
        error: new Error(
          'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
        ),
        expected: true,
      },
      {
        name: 'quicknode span cap',
        error: new Error('eth_getLogs is limited to a 10000 range'),
        expected: true,
      },
      {
        name: 'ankr span cap',
        error: new Error('block range is too wide'),
        expected: true,
      },
      {
        name: 'span cap reported on a nested json-rpc error',
        error: Object.assign(new Error('processing response error'), {
          error: { code: -32005, message: 'exceed maximum block range: 5000' },
        }),
        expected: true,
      },
      {
        name: 'span cap wrapped by the smart provider combined error',
        error: new Error('All providers failed on chain test', {
          cause: new Error('requested too many blocks'),
        }),
        expected: true,
      },
      {
        // The transport refusing to split a span into more sub-queries has to
        // read as a range rejection, otherwise the scan fails where halving
        // would have completed it.
        name: 'the transport refusing its own sub-query bound',
        error: new LogBlockRangeTooLargeError(
          'Serving blocks 0 to 2000 needs 2001 queries at a block range of 1, above the 2000 this provider issues for one request',
        ),
        expected: true,
      },
      {
        name: 'the sub-query bound wrapped by the smart provider combined error',
        error: new Error('All providers failed on chain test', {
          cause: new LogBlockRangeTooLargeError(
            'Serving blocks 0 to 2000 needs 2001 queries at a block range of 1, above the 2000 this provider issues for one request',
          ),
        }),
        expected: true,
      },
      {
        // Classified by type alone, so rewording the message the transport
        // throws cannot turn halving into a hard failure.
        name: 'the sub-query bound reworded past every message signal',
        error: new LogBlockRangeTooLargeError('too much work for one request'),
        expected: true,
      },
      {
        name: 'the reworded sub-query bound wrapped by the smart provider combined error',
        error: new Error('All providers failed on chain test', {
          cause: new LogBlockRangeTooLargeError(
            'too much work for one request',
          ),
        }),
        expected: true,
      },
      {
        name: 'rate limit',
        error: new Error('429 Too Many Requests'),
        expected: false,
      },
      {
        name: 'per second request quota',
        error: new Error('Your plan is limited to 25 requests per second'),
        expected: false,
      },
      {
        name: 'timeout',
        error: new Error('ETIMEDOUT: request timed out'),
        expected: false,
      },
      {
        name: 'auth failure',
        error: new Error('401 unauthorized: invalid api key'),
        expected: false,
      },
      {
        name: 'missing error',
        error: undefined,
        expected: false,
      },
    ];

    for (const c of cases) {
      it(`classifies ${c.name}`, () => {
        expect(isBlockRangeError(c.error)).to.equal(c.expected);
      });
    }
  });

  describe(isTerminalLogReadError.name, () => {
    interface ClassificationCase {
      name: string;
      error: unknown;
      expected: boolean;
    }

    const cases: ClassificationCase[] = [
      {
        name: 'an ethers http rejection carrying a 401 status',
        error: Object.assign(new Error('bad response'), { status: 401 }),
        expected: true,
      },
      {
        name: 'an ethers http rejection carrying a 403 status',
        error: Object.assign(new Error('bad response'), { statusCode: 403 }),
        expected: true,
      },
      {
        name: 'a status reported on a nested error',
        error: Object.assign(new Error('processing response error'), {
          error: { status: 401 },
        }),
        expected: true,
      },
      {
        name: 'an api key rejection reported in the message alone',
        error: new Error('401 unauthorized: invalid api key'),
        expected: true,
      },
      {
        name: 'a forbidden response body',
        error: Object.assign(new Error('bad response'), {
          body: '<html><title>403 Forbidden</title></html>',
        }),
        expected: true,
      },
      {
        name: 'an error the producing layer flagged as non recoverable',
        error: Object.assign(new Error('CALL_EXCEPTION'), {
          isRecoverable: false,
        }),
        expected: true,
      },
      {
        name: 'a non recoverable error behind a wrapper',
        error: new Error('All providers failed on chain test', {
          cause: Object.assign(new Error('NETWORK_ERROR'), {
            isRecoverable: false,
          }),
        }),
        expected: true,
      },
      {
        name: 'an error the producing layer flagged as recoverable',
        error: Object.assign(new Error('server error'), {
          isRecoverable: true,
        }),
        expected: false,
      },
      {
        name: 'a block range rejection',
        error: new Error('query returned more than 10000 results'),
        expected: false,
      },
      {
        name: 'the transport refusing its own sub-query bound',
        error: new LogBlockRangeTooLargeError(
          'Serving blocks 0 to 2000 needs 2001 queries at a block range of 1, above the 2000 this provider issues for one request',
        ),
        expected: false,
      },
      {
        name: 'a rate limit',
        error: Object.assign(new Error('bad response'), { status: 429 }),
        expected: false,
      },
      {
        name: 'a timeout',
        error: new Error('ETIMEDOUT: request timed out'),
        expected: false,
      },
      {
        name: 'a block number that merely contains a terminal status',
        error: new Error('missing block 401403'),
        expected: false,
      },
      {
        name: 'a missing error',
        error: undefined,
        expected: false,
      },
    ];

    for (const c of cases) {
      it(`classifies ${c.name}`, () => {
        expect(isTerminalLogReadError(c.error)).to.equal(c.expected);
      });
    }
  });
});
