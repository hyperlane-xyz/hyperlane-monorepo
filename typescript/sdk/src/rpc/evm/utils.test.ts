import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, providers, utils } from 'ethers';
import sinon from 'sinon';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import {
  LogBlockHistoryUnavailableError,
  LogBlockRangeTooLargeError,
} from '../../providers/SmartProvider/HyperlaneJsonRpcProvider.js';
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
const SPAN_REJECTION_MESSAGE = 'query returned more than 10000 results';
// A failure that says nothing about the span, so the pagination loop retries it
// before it ever shrinks the range.
const TRANSIENT_FAILURE_MESSAGE = 'ETIMEDOUT: request timed out';

chai.use(chaiAsPromised);

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
  // when the RPC declares a maxBlockRange narrower than the chunk. The stub
  // itself is returned alongside so that a test can count the round trips a
  // chunk cost, including the ones that never reached eth_getLogs.
  function stubTransport(): {
    served: ServedRange[];
    transport: sinon.SinonStub;
  } {
    const served: ServedRange[] = [];

    const transport = sinon
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

    return { served, transport };
  }

  function blockWindow(filter: unknown): ServedRange {
    if (typeof filter !== 'object' || filter === null) {
      throw new Error('Expected getLogsFromRpc to pass a log filter object');
    }
    const fromBlock: unknown = Reflect.get(filter, 'fromBlock');
    const toBlock: unknown = Reflect.get(filter, 'toBlock');
    if (typeof fromBlock !== 'number' || typeof toBlock !== 'number') {
      throw new Error('Expected numeric block bounds on the log filter');
    }
    return { fromBlock, toBlock };
  }

  // The chunks getLogsFromRpc asked the provider for, as opposed to the
  // narrower ones the provider then split them into for the transport.
  function requestedChunks(getLogs: sinon.SinonSpy): ServedRange[] {
    return getLogs.getCalls().map((call) => blockWindow(call.args[0]));
  }

  function spanOf({ fromBlock, toBlock }: ServedRange): number {
    return toBlock - fromBlock + 1;
  }

  // Mimics a provider that caps how many blocks one eth_getLogs may span,
  // without the transport's own splitting or the smart provider's retries in
  // between, so the chunks the pagination loop chose are what is observed.
  function stubBlockSpanLimit(
    multiProvider: MultiProvider,
    maxSpan: number,
    rejectionMessage: string = SPAN_REJECTION_MESSAGE,
  ): sinon.SinonStub {
    const provider = multiProvider.getProvider(CHAIN_NAME);
    return sinon.stub(provider, 'getLogs').callsFake(async (filter) => {
      const requested = blockWindow(await filter);
      if (spanOf(requested) > maxSpan) {
        throw new Error(rejectionMessage);
      }
      return [];
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
      const { served } = stubTransport();
      const multiProvider = new MultiProvider({
        [CHAIN_NAME]: chainMetadata(2),
      });

      await getLogsFromRpc({
        chain: CHAIN_NAME,
        contractAddress: CONTRACT_ADDRESS,
        multiProvider,
        fromBlock: 0,
        toBlock: 19,
        topic: TRANSFER_TOPIC,
        range: 1_000,
      });

      expectFullCoverage(served, 0, 19);
      const widestServed = Math.max(
        ...served.map(({ fromBlock, toBlock }) => toBlock - fromBlock + 1),
      );
      expect(widestServed).to.equal(2);
    });

    it('clamps the final chunk to the end block', async () => {
      const { served } = stubTransport();
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
      const { served } = stubTransport();
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

    // The transport refuses a chunk it would have to split into more sub-queries
    // than it issues for one request. That refusal has to reach the halving
    // ladder, otherwise a caller asking for a wide range on an RPC declaring a
    // narrow one fails outright instead of completing at a smaller chunk size.
    it('halves the range when the transport refuses its own sub-query bound', async () => {
      const { served } = stubTransport();
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
        toBlock: 20,
        topic: TRANSFER_TOPIC,
        range: 21,
      });

      expect(requestedChunks(getLogs)).to.deep.equal([
        { fromBlock: 0, toBlock: 20 },
        { fromBlock: 0, toBlock: 9 },
        { fromBlock: 10, toBlock: 19 },
        { fromBlock: 20, toBlock: 20 },
      ]);
      expectFullCoverage(served, 0, 20);
    });

    // The refusal is derived from the requested span before any log query goes
    // out, so the smart provider's retry budget only bought the same answer
    // three times over, at the two backoffs between the attempts.
    it('never retries a chunk the transport refused to split', async () => {
      const { transport } = stubTransport();
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
        toBlock: 20,
        topic: TRANSFER_TOPIC,
        range: 21,
      });

      // The block height each requested chunk is measured against, which is
      // the only round trip a refused chunk makes and is therefore one per
      // attempt at it.
      const heightProbes = transport
        .getCalls()
        .filter((call) => call.args[0] === ProviderMethod.GetBlockNumber);
      expect(heightProbes).to.have.length(4);
      expect(requestedChunks(getLogs)).to.have.length(4);
    });

    // Classifying a range rejection before the terminal check must not put the
    // other refusal the transport raises on the halving ladder with it: no
    // chunk size reaches history the endpoint does not hold.
    it('rethrows a history floor refusal at the first chunk', async () => {
      const multiProvider = new MultiProvider({
        [CHAIN_NAME]: chainMetadata(),
      });
      const getLogs = sinon
        .stub(multiProvider.getProvider(CHAIN_NAME), 'getLogs')
        .rejects(
          new Error('All providers failed on chain test', {
            cause: new LogBlockHistoryUnavailableError(
              'Blocks 0 to 999 were requested, but this provider serves no block below 5000',
            ),
          }),
        );

      await expect(
        getLogsFromRpc({
          chain: CHAIN_NAME,
          contractAddress: CONTRACT_ADDRESS,
          multiProvider,
          fromBlock: 0,
          toBlock: 999,
          topic: TRANSFER_TOPIC,
          range: 1_000,
        }),
      ).to.be.rejectedWith('All providers failed on chain test');

      expect(requestedChunks(getLogs)).to.have.length(1);
    });

    // The end block clips the first chunk of a shallow scan to far less than
    // the configured range, so halving the range left the request unchanged and
    // the same rejected span was re-issued once per factor of two between the
    // two: about fourteen times for this one.
    it('never re-requests a span the provider already rejected', async () => {
      const multiProvider = new MultiProvider({
        [CHAIN_NAME]: chainMetadata(),
      });
      const getLogs = stubBlockSpanLimit(multiProvider, 10);

      await getLogsFromRpc({
        chain: CHAIN_NAME,
        contractAddress: CONTRACT_ADDRESS,
        multiProvider,
        fromBlock: 0,
        toBlock: 92,
        topic: TRANSFER_TOPIC,
        range: 1_000_000,
      });

      const chunks = requestedChunks(getLogs);
      expect(chunks.slice(0, 5)).to.deep.equal([
        { fromBlock: 0, toBlock: 92 },
        { fromBlock: 0, toBlock: 45 },
        { fromBlock: 0, toBlock: 22 },
        { fromBlock: 0, toBlock: 10 },
        { fromBlock: 0, toBlock: 4 },
      ]);
      const identities = chunks.map(
        ({ fromBlock, toBlock }) => `${fromBlock}:${toBlock}`,
      );
      expect(new Set(identities).size).to.equal(chunks.length);
      expectFullCoverage(
        chunks.filter((chunk) => spanOf(chunk) <= 10),
        0,
        92,
      );
    });

    // Halving on a failure that named no span is a guess that the signal list
    // missed this provider's phrasing. A provider that is simply down answers
    // the same way at every range, and unbounded that guess walked a wide range
    // to the one block minimum, at four attempts and their backoffs per rung.
    it('stops halving an unrecognised failure at a floor measured in blocks', async function () {
      this.timeout(10_000);
      const multiProvider = new MultiProvider({
        [CHAIN_NAME]: chainMetadata(),
      });
      const getLogs = sinon
        .stub(multiProvider.getProvider(CHAIN_NAME), 'getLogs')
        .rejects(new Error(TRANSIENT_FAILURE_MESSAGE));

      await expect(
        getLogsFromRpc({
          chain: CHAIN_NAME,
          contractAddress: CONTRACT_ADDRESS,
          multiProvider,
          fromBlock: 0,
          toBlock: 999,
          topic: TRANSFER_TOPIC,
          range: 1_000,
        }),
      ).to.be.rejectedWith(TRANSIENT_FAILURE_MESSAGE);

      // One attempt and three retries at the requested range and at each halved
      // range down to the first below one hundred blocks, after which the
      // provider's own error is rethrown rather than a narrower range tried.
      expect(requestedChunks(getLogs).map(spanOf)).to.deep.equal([
        1_000, 1_000, 1_000, 1_000, 500, 500, 500, 500, 250, 250, 250, 250, 125,
        125, 125, 125, 62, 62, 62, 62,
      ]);
    });

    // Bounding that guess by a count of halvings was only as strict as the
    // range it counted from: three halvings of the 1,000,000 blocks the xERC20
    // scan asks for stops at 125,000, above every cap a real provider enforces,
    // so a cap phrased outside the signal list failed the read where the same
    // three halvings of the 500 block default would have found it.
    it('reaches a provider cap far below a wide configured range', async function () {
      this.timeout(30_000);
      const multiProvider = new MultiProvider({
        [CHAIN_NAME]: chainMetadata(),
      });
      // The 10,000 block cap gnosis and arthera declare, phrased so that none
      // of the block range signals match it.
      const getLogs = stubBlockSpanLimit(
        multiProvider,
        10_000,
        TRANSIENT_FAILURE_MESSAGE,
      );

      await getLogsFromRpc({
        chain: CHAIN_NAME,
        contractAddress: CONTRACT_ADDRESS,
        multiProvider,
        fromBlock: 0,
        toBlock: 999_999,
        topic: TRANSFER_TOPIC,
        range: 1_000_000,
      });

      const accepted = requestedChunks(getLogs).filter(
        (chunk) => spanOf(chunk) <= 10_000,
      );
      expect(Math.max(...accepted.map(spanOf))).to.equal(7_812);
      expectFullCoverage(accepted, 0, 999_999);
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
          'Serving blocks 0 to 21 needs 11 queries at a block range of 2, above the 10 this provider issues for one request',
        ),
        expected: true,
      },
      {
        name: 'the sub-query bound wrapped by the smart provider combined error',
        error: new Error('All providers failed on chain test', {
          cause: new LogBlockRangeTooLargeError(
            'Serving blocks 0 to 21 needs 11 queries at a block range of 2, above the 10 this provider issues for one request',
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
        name: 'a public node span cap phrased as a query limit',
        error: new Error('please limit your query to at most 1000 blocks'),
        expected: true,
      },
      {
        // Word for word the phrasing above, with a rate where the span was, so
        // nothing but the rate tells the two apart. Halving on it would be
        // sticky for the rest of the scan and would not slow the scan down,
        // which is the one thing the provider asked for.
        name: 'a throttle phrased as the same query limit',
        error: new Error('please limit your query to 10 requests per second'),
        expected: false,
      },
      {
        name: 'a throttle asking for a slower query rate per minute',
        error: new Error('please limit your query to 600 calls per minute'),
        expected: false,
      },
      {
        // What is matched is the whole flattened error chain, and for a
        // getLogs failure that chain carries the smart provider's echo of the
        // request params, whose fromBlock and toBlock keys supply the word
        // block whatever the provider itself said.
        name: 'a throttle behind the smart provider echo of the request params',
        error: new Error(
          'All providers failed on chain test for method getLogs and params {"filter":{"fromBlock":"0x0","toBlock":"0x1f4"}}',
          {
            cause: new Error(
              'please limit your query to 10 requests per second',
            ),
          },
        ),
        expected: false,
      },
      {
        name: 'a span cap behind the smart provider echo of the request params',
        error: new Error(
          'All providers failed on chain test for method getLogs and params {"filter":{"fromBlock":"0x0","toBlock":"0x1f4"}}',
          {
            cause: new Error('please limit your query to at most 1000 blocks'),
          },
        ),
        expected: true,
      },
      {
        // No chunk of history the endpoint does not hold exists at any size, so
        // reading this as a span rejection would halve to the one block minimum
        // and fail there anyway.
        name: 'the transport refusing to reach below the history it serves',
        error: new LogBlockHistoryUnavailableError(
          'Blocks 0 to 100 were requested, but this provider serves no block below 90',
        ),
        expected: false,
      },
      {
        name: 'the history floor reported for a max block age',
        error: new LogBlockHistoryUnavailableError(
          'Blocks 60 to 100 were requested, but at block height 100 a max block age of 20 leaves this provider serving no block below 80',
        ),
        expected: false,
      },
      {
        name: 'rate limit',
        error: new Error('429 Too Many Requests'),
        expected: false,
      },
      {
        // Halving on this would be sticky for the rest of the scan and would
        // not have addressed the rate the provider was complaining about.
        name: 'a throttle asking the caller to limit their query rate',
        error: new Error('please limit your query rate to 10 per second'),
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
        name: 'an endpoint answering 404 at the configured url',
        error: Object.assign(new Error('bad response'), { status: 404 }),
        expected: true,
      },
      {
        name: 'an endpoint answering 405 to the json-rpc post',
        error: Object.assign(new Error('bad response'), { statusCode: 405 }),
        expected: true,
      },
      {
        name: 'a json-rpc method not found code on a nested error',
        error: Object.assign(new Error('processing response error'), {
          error: {
            code: -32601,
            message: 'the method eth_getLogs does not exist/is not available',
          },
        }),
        expected: true,
      },
      {
        name: 'a method rejection reported in the message alone',
        error: new Error('Method not found'),
        expected: true,
      },
      {
        // ethers puts its own string codes on the same field, and none of them
        // say anything about whether the read can succeed.
        name: 'an ethers string error code',
        error: Object.assign(new Error('bad response'), {
          code: 'SERVER_ERROR',
        }),
        expected: false,
      },
      {
        name: 'a not found message about a block rather than the endpoint',
        error: new Error('block not found'),
        expected: false,
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
        // Terminal in the sense this predicate reads, because the refusal is
        // derived from the requested span alone and repeating the identical
        // request cannot change it. A narrower request still can, which is why
        // getLogsFromRpc asks isBlockRangeError before this.
        name: 'the transport refusing its own sub-query bound',
        error: new LogBlockRangeTooLargeError(
          'Serving blocks 0 to 21 needs 11 queries at a block range of 2, above the 10 this provider issues for one request',
        ),
        expected: true,
      },
      {
        // Only another RPC can serve history this one does not hold, so the
        // read has to surface at once rather than after the whole ladder.
        name: 'the transport refusing to reach below the history it serves',
        error: new LogBlockHistoryUnavailableError(
          'Blocks 0 to 100 were requested, but this provider serves no block below 90',
        ),
        expected: true,
      },
      {
        name: 'the history floor wrapped by the smart provider combined error',
        error: new Error('All providers failed on chain test', {
          cause: new LogBlockHistoryUnavailableError(
            'Blocks 0 to 100 were requested, but this provider serves no block below 90',
          ),
        }),
        expected: true,
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
