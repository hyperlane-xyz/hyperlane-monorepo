import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { retryAsync } from '@hyperlane-xyz/utils';

import { GetEventLogsResponse } from '../rpc/evm/types.js';

import {
  getContractDeploymentTransaction,
  getLogsFromEtherscanLikeExplorerAPI,
} from './etherscan.js';
import {
  CONTRACT_ADDRESS,
  CONTRACT_CREATOR,
  DEPLOYMENT_TX_HASH,
  EXPLORER_API_URL,
  explorerLogsResponse,
  explorerResponse,
  explorerResultResponse,
} from './testFixtures.js';

chai.use(chaiAsPromised);

const DEPLOYMENT_BLOCK_NUMBER = 5755676;
// Mirrors retryAsync's own default, which is what EvmEventLogsReader relies on.
const ATTEMPT_LIMIT = 5;

interface RetryCase {
  name: string;
  body: unknown;
  expectedAttempts: number;
  expectedErrorIncludes: string;
}

const retryCases: RetryCase[] = [
  {
    // The explorer has answered; re-asking cannot change the answer, so the
    // error carries isRecoverable = false and retryAsync must give up at once.
    name: 'stops after one attempt when the explorer has no deployment record',
    body: { status: '0', message: 'No records found', result: [] },
    expectedAttempts: 1,
    expectedErrorIncludes: `No deployment transaction found for contract ${CONTRACT_ADDRESS}`,
  },
  {
    name: 'exhausts the retry budget when the explorer request fails',
    body: { status: '0', message: 'NOTOK', result: 'Max rate limit reached' },
    expectedAttempts: ATTEMPT_LIMIT,
    expectedErrorIncludes:
      'Error while performing request to Etherscan like API at explorer.example: NOTOK Max rate limit reached',
  },
];

interface BlockNumberCase {
  name: string;
  result: Record<string, unknown>;
  expectedBlockNumber?: number;
}

const blockNumberCases: BlockNumberCase[] = [
  {
    name: 'parses the decimal string block number returned by Etherscan and Blockscout',
    result: {
      contractAddress: CONTRACT_ADDRESS,
      contractCreator: CONTRACT_CREATOR,
      txHash: DEPLOYMENT_TX_HASH,
      blockNumber: `${DEPLOYMENT_BLOCK_NUMBER}`,
    },
    expectedBlockNumber: DEPLOYMENT_BLOCK_NUMBER,
  },
  {
    name: 'parses the JSON number block number returned by explorers like 0g chainscan',
    result: {
      contractAddress: CONTRACT_ADDRESS,
      contractCreator: CONTRACT_CREATOR,
      txHash: DEPLOYMENT_TX_HASH,
      blockNumber: DEPLOYMENT_BLOCK_NUMBER,
    },
    expectedBlockNumber: DEPLOYMENT_BLOCK_NUMBER,
  },
  {
    name: 'leaves the block number unset when the explorer does not report one',
    result: {
      contractAddress: CONTRACT_ADDRESS,
      contractCreator: CONTRACT_CREATOR,
      txHash: DEPLOYMENT_TX_HASH,
    },
    expectedBlockNumber: undefined,
  },
];

describe('getContractDeploymentTransaction', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  for (const c of blockNumberCases) {
    it(c.name, async () => {
      sandbox
        .stub(globalThis, 'fetch')
        .callsFake(async () => explorerResultResponse(c.result));

      const deploymentTx = await getContractDeploymentTransaction(
        { apiUrl: EXPLORER_API_URL },
        { contractAddress: CONTRACT_ADDRESS },
      );

      expect(deploymentTx.blockNumber).to.equal(c.expectedBlockNumber);
      expect(deploymentTx.txHash).to.equal(DEPLOYMENT_TX_HASH);
      expect(deploymentTx.contractCreator).to.equal(CONTRACT_CREATOR);
    });
  }

  it('rejects a block number that is not a hex or decimal number', async () => {
    sandbox.stub(globalThis, 'fetch').callsFake(async () =>
      explorerResultResponse({
        contractAddress: CONTRACT_ADDRESS,
        contractCreator: CONTRACT_CREATOR,
        txHash: DEPLOYMENT_TX_HASH,
        blockNumber: 'pending',
      }),
    );

    await expect(
      getContractDeploymentTransaction(
        { apiUrl: EXPLORER_API_URL },
        { contractAddress: CONTRACT_ADDRESS },
      ),
    ).to.be.rejectedWith(
      'blockNumber string "pending" is not a valid hex or decimal number',
    );
  });

  for (const c of retryCases) {
    it(c.name, async () => {
      const fetchStub = sandbox
        .stub(globalThis, 'fetch')
        .callsFake(async () => explorerResponse(c.body));

      let attempts = 0;
      await expect(
        retryAsync(
          () => {
            attempts++;
            return getContractDeploymentTransaction(
              { apiUrl: EXPLORER_API_URL },
              { contractAddress: CONTRACT_ADDRESS },
            );
          },
          ATTEMPT_LIMIT,
          1,
        ),
      ).to.be.rejectedWith(c.expectedErrorIncludes);

      expect(attempts).to.equal(c.expectedAttempts);
      expect(fetchStub.callCount).to.equal(c.expectedAttempts);
    });
  }
});

const EVENT_TOPIC = `0x${'11'.repeat(32)}`;
// Both measured against Etherscan V2 on chainid 1: a request naming no page is
// answered with the first 1000 records of the range and a success status, and
// page 11 is refused.
const PAGE_SIZE = 1_000;
const PAGE_CEILING = 10;

function blockHash(blockNumber: number): string {
  return `0x${blockNumber.toString(16).padStart(64, '0')}`;
}

function rawExplorerLog(blockNumber: number, logIndex: number) {
  return {
    address: CONTRACT_ADDRESS,
    blockNumber: `0x${blockNumber.toString(16)}`,
    data: '0x',
    gasPrice: '0x1',
    gasUsed: '0x1',
    logIndex: `0x${logIndex.toString(16)}`,
    timeStamp: '0x1',
    topics: [EVENT_TOPIC],
    transactionHash: blockHash(blockNumber),
    transactionIndex: '0x0',
  };
}

// Two logs per block, so a page boundary can be made to fall inside a block.
function rawExplorerLogs(firstBlock: number, count: number) {
  return Array.from({ length: count }, (_, index) =>
    rawExplorerLog(firstBlock + Math.floor(index / 2), index % 2),
  );
}

function logIdentities(logs: GetEventLogsResponse[]): Set<string> {
  return new Set(
    logs.map(
      (log) => `${log.blockNumber}:${log.transactionHash}:${log.logIndex}`,
    ),
  );
}

describe('getLogsFromEtherscanLikeExplorerAPI', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  function requestedPages(
    fetchStub: sinon.SinonStub,
  ): Array<{ page: string | null; offset: string | null }> {
    return fetchStub.getCalls().map((call) => {
      const params = new URL(String(call.args[0])).searchParams;
      return { page: params.get('page'), offset: params.get('offset') };
    });
  }

  it('names the page and the records per page, and stops at the first page the explorer cannot fill', async () => {
    const fetchStub = sandbox
      .stub(globalThis, 'fetch')
      .callsFake(async () => explorerLogsResponse(rawExplorerLogs(100, 3)));

    const logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl: EXPLORER_API_URL },
      {
        address: CONTRACT_ADDRESS,
        fromBlock: 100,
        toBlock: 200,
        topic0: EVENT_TOPIC,
      },
    );

    expect(requestedPages(fetchStub)).to.deep.equal([
      { page: '1', offset: '1000' },
    ]);
    expect(logs).to.deep.equal([
      {
        address: CONTRACT_ADDRESS,
        blockNumber: 100,
        data: '0x',
        logIndex: 0,
        topics: [EVENT_TOPIC],
        transactionHash: `0x${'0'.repeat(62)}64`,
        transactionIndex: 0,
      },
      {
        address: CONTRACT_ADDRESS,
        blockNumber: 100,
        data: '0x',
        logIndex: 1,
        topics: [EVENT_TOPIC],
        transactionHash: `0x${'0'.repeat(62)}64`,
        transactionIndex: 0,
      },
      {
        address: CONTRACT_ADDRESS,
        blockNumber: 101,
        data: '0x',
        logIndex: 0,
        topics: [EVENT_TOPIC],
        transactionHash: `0x${'0'.repeat(62)}65`,
        transactionIndex: 0,
      },
    ]);
  });

  // Without the paging the first response is the whole answer, and it holds the
  // first 1000 records of the range under a success status.
  it('reads the records past the first page and keeps the boundary block once', async () => {
    const pages = [
      // Blocks 1 to 500, the last of which fills the page.
      rawExplorerLogs(1, PAGE_SIZE),
      // The explorer resumes at the boundary block, repeating both of its logs.
      [...rawExplorerLogs(500, 2), ...rawExplorerLogs(501, 3)],
    ];
    const fetchStub = sandbox.stub(globalThis, 'fetch');
    // The page numbers actually asked for are pinned below; here the responses
    // just follow the order of the requests.
    fetchStub.callsFake(async () =>
      explorerLogsResponse(pages[fetchStub.callCount - 1] ?? []),
    );

    const logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl: EXPLORER_API_URL },
      {
        address: CONTRACT_ADDRESS,
        fromBlock: 1,
        toBlock: 1_000,
        topic0: EVENT_TOPIC,
      },
    );

    expect(requestedPages(fetchStub)).to.deep.equal([
      { page: '1', offset: '1000' },
      { page: '2', offset: '1000' },
    ]);
    // 1005 records were served, of which the boundary block's two are repeats.
    expect(logs).to.have.length(1_003);
    expect(logIdentities(logs).size).to.equal(1_003);
    expect(logs.filter((log) => log.blockNumber === 500)).to.have.length(2);
    expect(logs[logs.length - 1]).to.deep.equal({
      address: CONTRACT_ADDRESS,
      blockNumber: 502,
      data: '0x',
      logIndex: 0,
      topics: [EVENT_TOPIC],
      transactionHash: blockHash(502),
      transactionIndex: 0,
    });
  });

  it('throws rather than return the prefix it collected when the page ceiling is reached', async () => {
    const fetchStub = sandbox.stub(globalThis, 'fetch');
    // Every page is full and holds records the earlier ones did not, so nothing
    // but the ceiling can end the loop.
    fetchStub.callsFake(async () =>
      explorerLogsResponse(
        rawExplorerLogs(
          1 + (fetchStub.callCount - 1) * (PAGE_SIZE / 2),
          PAGE_SIZE,
        ),
      ),
    );

    let attempts = 0;
    await expect(
      retryAsync(
        () => {
          attempts++;
          return getLogsFromEtherscanLikeExplorerAPI(
            { apiUrl: EXPLORER_API_URL },
            {
              address: CONTRACT_ADDRESS,
              fromBlock: 1,
              toBlock: 100_000,
              topic0: EVENT_TOPIC,
            },
          );
        },
        ATTEMPT_LIMIT,
        1,
      ),
    ).to.be.rejectedWith(
      `Explorer served 10 full pages of 1000 logs for contract ${CONTRACT_ADDRESS} between blocks 1 and 100000, which is as far as it pages, so the logs of that range cannot be read in full`,
    );

    // A ceiling is not a transient failure, so the reader falls through to its
    // RPC strategy on the first answer instead of asking nine more times.
    expect(attempts).to.equal(1);
    expect(fetchStub.callCount).to.equal(PAGE_CEILING);
  });

  // NaN compares false against everything, so a log index read this way loses
  // the ordering comparisons the callers of this run on: of two configurations
  // of one bridge in a block, the first would win instead of the last.
  it('reads the bare 0x a zero valued field is reported as', async () => {
    sandbox.stub(globalThis, 'fetch').callsFake(async () =>
      explorerLogsResponse([
        {
          address: CONTRACT_ADDRESS,
          blockNumber: '0x64',
          data: '0x',
          gasPrice: '0x1',
          gasUsed: '0x1',
          logIndex: '0x',
          timeStamp: '0x1',
          topics: [EVENT_TOPIC],
          transactionHash: blockHash(100),
          transactionIndex: '0x',
        },
      ]),
    );

    const logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl: EXPLORER_API_URL },
      {
        address: CONTRACT_ADDRESS,
        fromBlock: 100,
        toBlock: 200,
        topic0: EVENT_TOPIC,
      },
    );

    expect(logs).to.deep.equal([
      {
        address: CONTRACT_ADDRESS,
        blockNumber: 100,
        data: '0x',
        logIndex: 0,
        topics: [EVENT_TOPIC],
        transactionHash: blockHash(100),
        transactionIndex: 0,
      },
    ]);
  });

  it('rejects a log field that is not a number', async () => {
    sandbox.stub(globalThis, 'fetch').callsFake(async () =>
      explorerLogsResponse([
        {
          ...rawExplorerLog(100, 0),
          logIndex: 'pending',
        },
      ]),
    );

    await expect(
      getLogsFromEtherscanLikeExplorerAPI(
        { apiUrl: EXPLORER_API_URL },
        {
          address: CONTRACT_ADDRESS,
          fromBlock: 100,
          toBlock: 200,
          topic0: EVENT_TOPIC,
        },
      ),
    ).to.be.rejectedWith(
      'logIndex string "pending" is not a valid hex or decimal number',
    );
  });

  it('retries a page the explorer did not serve without re-reading the pages before it', async () => {
    const fetchStub = sandbox.stub(globalThis, 'fetch');
    fetchStub
      .onCall(0)
      .callsFake(async () =>
        explorerLogsResponse(rawExplorerLogs(1, PAGE_SIZE)),
      );
    fetchStub.onCall(1).callsFake(async () =>
      explorerResponse({
        status: '0',
        message: 'NOTOK',
        result: 'Max rate limit reached',
      }),
    );
    fetchStub
      .onCall(2)
      .callsFake(async () => explorerLogsResponse(rawExplorerLogs(500, 2)));

    const logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl: EXPLORER_API_URL },
      {
        address: CONTRACT_ADDRESS,
        fromBlock: 1,
        toBlock: 1_000,
        topic0: EVENT_TOPIC,
      },
    );

    expect(requestedPages(fetchStub)).to.deep.equal([
      { page: '1', offset: '1000' },
      { page: '2', offset: '1000' },
      { page: '2', offset: '1000' },
    ]);
    expect(logs).to.have.length(PAGE_SIZE);
  });

  it('stops the read for the whole range once a page cannot be served', async () => {
    const fetchStub = sandbox.stub(globalThis, 'fetch');
    fetchStub.callsFake(async () =>
      fetchStub.callCount === 1
        ? explorerLogsResponse(rawExplorerLogs(1, PAGE_SIZE))
        : explorerResponse({
            status: '0',
            message: 'NOTOK',
            result: 'Max rate limit reached',
          }),
    );

    let attempts = 0;
    await expect(
      retryAsync(
        () => {
          attempts++;
          return getLogsFromEtherscanLikeExplorerAPI(
            { apiUrl: EXPLORER_API_URL },
            {
              address: CONTRACT_ADDRESS,
              fromBlock: 1,
              toBlock: 1_000,
              topic0: EVENT_TOPIC,
            },
          );
        },
        ATTEMPT_LIMIT,
        1,
      ),
    ).to.be.rejectedWith(
      `Explorer failed to serve page 2 of the logs for contract ${CONTRACT_ADDRESS} between blocks 1 and 1000`,
    );

    // The retries the page was worth were spent below, so the reader falls
    // through to its RPC strategy rather than asking for page 1 again.
    expect(attempts).to.equal(1);
    expect(fetchStub.callCount).to.equal(1 + ATTEMPT_LIMIT);
  });

  it('rejects a log result that is not a list', async () => {
    sandbox.stub(globalThis, 'fetch').callsFake(async () =>
      explorerResponse({
        status: '0',
        message: 'No logs found',
        result: null,
      }),
    );

    await expect(
      getLogsFromEtherscanLikeExplorerAPI(
        { apiUrl: EXPLORER_API_URL },
        {
          address: CONTRACT_ADDRESS,
          fromBlock: 1,
          toBlock: 200,
          topic0: EVENT_TOPIC,
        },
      ),
    ).to.be.rejectedWith(
      `Explorer did not return a list of logs for contract ${CONTRACT_ADDRESS} between blocks 1 and 200`,
    );
  });
});
