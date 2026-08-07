import { expect } from 'chai';
import sinon from 'sinon';

import { contractDouble } from '../test/contractDouble.js';

import {
  type RawEtherscanGetEventLogsResponse,
  getLogsFromEtherscanLikeExplorerAPI,
} from './etherscan.js';

const API_URL = 'https://api.example.com/api';
const CONTRACT_ADDRESS = '0x5d4C14B895392BD935583ebFfE0f5159540FE8bC';
const TOPIC =
  '0x6fdaf3cd8c245bcc67646386e905ab1e2e12ec4d669c2f66c2ce2e0b55e2ce74';

// Matches the page size `getLogsFromEtherscanLikeExplorerAPI` requests.
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

function rawLog(index: number): RawEtherscanGetEventLogsResponse {
  return {
    address: CONTRACT_ADDRESS,
    blockNumber: `0x${(1000 + index).toString(16)}`,
    data: '0x',
    gasPrice: '0x1',
    gasUsed: '0x1',
    logIndex: `0x${(index % 8).toString(16)}`,
    timeStamp: '0x64000000',
    topics: [TOPIC, `0x${index.toString(16).padStart(64, '0')}`],
    transactionHash: `0x${index.toString(16).padStart(64, 'a')}`,
    transactionIndex: '0x0',
  };
}

function rawLogPage(
  count: number,
  startIndex = 0,
): RawEtherscanGetEventLogsResponse[] {
  return Array.from({ length: count }, (_, offset) =>
    rawLog(startIndex + offset),
  );
}

function okResponse(result: unknown): Response {
  return contractDouble<Response>({
    url: API_URL,
    json: async () => ({ status: '1', message: 'OK', result }),
  });
}

// The shape Blockscout and zkSync return for a query with no matches, and for a
// page past the end: status 0 with an empty array.
function noRecordsResponse(message = 'No logs found'): Response {
  return contractDouble<Response>({
    url: API_URL,
    json: async () => ({ status: '0', message, result: [] }),
  });
}

// A transient condition: the same request usually succeeds on a retry.
function rateLimitedResponse(): Response {
  return contractDouble<Response>({
    url: API_URL,
    json: async () => ({
      status: '0',
      message: 'NOTOK',
      result: 'Max rate limit reached',
    }),
  });
}

// Some explorers reject a page beyond the first outright; zkSync answers
// `page=2&offset=1000` with this rather than with records.
function pageRejectedResponse(): Response {
  return contractDouble<Response>({
    url: API_URL,
    json: async () => ({
      status: '0',
      message: 'NOTOK',
      result:
        'Result window is too large, PageNo x Offset size must be less than or equal to 1000',
    }),
  });
}

function requestedPages(fetchStub: sinon.SinonStub): number[] {
  return fetchStub.getCalls().map((call) => {
    const url = new URL(String(call.args[0]));
    return Number(url.searchParams.get('page'));
  });
}

describe('getLogsFromEtherscanLikeExplorerAPI', () => {
  let fetchStub: sinon.SinonStub;

  const options = {
    address: CONTRACT_ADDRESS,
    fromBlock: 0,
    toBlock: 20_000_000,
    topic0: TOPIC,
  };

  beforeEach(() => {
    fetchStub = sinon.stub(global, 'fetch');
  });

  afterEach(() => {
    fetchStub.restore();
  });

  it('requests a bounded page and accumulates until a page comes back short', async () => {
    fetchStub.onCall(0).resolves(okResponse(rawLogPage(PAGE_SIZE)));
    fetchStub.onCall(1).resolves(okResponse(rawLogPage(5, PAGE_SIZE)));

    const logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl: API_URL },
      options,
    );

    expect(logs).to.have.lengthOf(PAGE_SIZE + 5);
    expect(requestedPages(fetchStub)).to.deep.equal([1, 2]);

    const firstUrl = new URL(String(fetchStub.firstCall.args[0]));
    expect(firstUrl.searchParams.get('offset')).to.equal(String(PAGE_SIZE));
    // Decoded values survive the extra request round trip.
    expect(logs[0].transactionHash).to.equal(rawLog(0).transactionHash);
    expect(logs[PAGE_SIZE].blockNumber).to.equal(1000 + PAGE_SIZE);
  });

  // Explorers end a walk either with an empty array or with the "no records"
  // status, and a page past the end is how the second is normally reached.
  const terminators: { name: string; response: () => Response }[] = [
    { name: 'an empty page', response: () => okResponse([]) },
    { name: 'a no-records page', response: noRecordsResponse },
  ];

  for (const terminator of terminators) {
    it(`reads one more page when the total is an exact multiple of the page size and ends with ${terminator.name}`, async () => {
      fetchStub.onCall(0).resolves(okResponse(rawLogPage(PAGE_SIZE)));
      fetchStub.onCall(1).resolves(terminator.response());

      const logs = await getLogsFromEtherscanLikeExplorerAPI(
        { apiUrl: API_URL },
        options,
      );

      expect(logs).to.have.lengthOf(PAGE_SIZE);
      expect(requestedPages(fetchStub)).to.deep.equal([1, 2]);
    });
  }

  it('rejects rather than duplicating when the explorer ignores the page param', async () => {
    fetchStub.resolves(okResponse(rawLogPage(PAGE_SIZE)));

    let thrown: unknown;
    try {
      await getLogsFromEtherscanLikeExplorerAPI({ apiUrl: API_URL }, options);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.an.instanceOf(Error);
    expect(String(thrown)).to.include('appears to ignore pagination');
    // Stops at the repeat instead of walking to the page cap.
    expect(requestedPages(fetchStub)).to.deep.equal([1, 2]);
  });

  it('rejects when every page up to the cap is full', async () => {
    for (let call = 0; call < MAX_PAGES; call++) {
      fetchStub
        .onCall(call)
        .resolves(okResponse(rawLogPage(PAGE_SIZE, call * PAGE_SIZE)));
    }

    let thrown: unknown;
    try {
      await getLogsFromEtherscanLikeExplorerAPI({ apiUrl: API_URL }, options);
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).to.include(`${MAX_PAGES} pages`);
    expect(fetchStub.callCount).to.equal(MAX_PAGES);
  });

  it('marks an unprovable result as unrecoverable so callers fall back', async () => {
    fetchStub.resolves(okResponse(rawLogPage(PAGE_SIZE)));

    let thrown: unknown;
    try {
      await getLogsFromEtherscanLikeExplorerAPI({ apiUrl: API_URL }, options);
    } catch (error) {
      thrown = error;
    }

    // `retryAsync` gives up immediately on this flag, so the reader reaches its
    // RPC fallback instead of repeating a query that cannot succeed.
    expect(thrown).to.have.property('isRecoverable', false);
  });

  it('reports a rejected later page as an unprovable set rather than a failed query', async () => {
    fetchStub.onCall(0).resolves(okResponse(rawLogPage(PAGE_SIZE)));
    fetchStub.onCall(1).resolves(pageRejectedResponse());

    let thrown: unknown;
    try {
      await getLogsFromEtherscanLikeExplorerAPI({ apiUrl: API_URL }, options);
    } catch (error) {
      thrown = error;
    }

    // Without this the explorer's own error surfaces as recoverable, so the
    // whole walk is retried before a caller with a fallback can use it.
    expect(thrown).to.have.property('isRecoverable', false);
    expect(String(thrown)).to.include('page 2 was rejected by the explorer');
    expect(String(thrown)).to.include('Result window is too large');
    expect(fetchStub.callCount).to.equal(2);
  });

  it('keeps a transient first-page failure retryable', async () => {
    fetchStub.onCall(0).resolves(rateLimitedResponse());

    let thrown: unknown;
    try {
      await getLogsFromEtherscanLikeExplorerAPI({ apiUrl: API_URL }, options);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.not.have.property('isRecoverable');
    expect(String(thrown)).to.include('Max rate limit reached');
  });

  it('rejects a first-page pagination rejection as unrecoverable', async () => {
    fetchStub.onCall(0).resolves(pageRejectedResponse());

    let thrown: unknown;
    try {
      await getLogsFromEtherscanLikeExplorerAPI({ apiUrl: API_URL }, options);
    } catch (error) {
      thrown = error;
    }

    // The offset itself is unservable here, so no retry can help.
    expect(thrown).to.have.property('isRecoverable', false);
    expect(String(thrown)).to.include('Result window is too large');
  });

  // A success is a success: the message is only a termination signal alongside
  // the no-records status.
  it('does not treat a full page as the end because of its message', async () => {
    fetchStub.onCall(0).resolves(okResponse(rawLogPage(PAGE_SIZE)));
    fetchStub.onCall(1).resolves(
      contractDouble<Response>({
        url: API_URL,
        json: async () => ({
          status: '1',
          message: 'No logs found',
          result: rawLogPage(5, PAGE_SIZE),
        }),
      }),
    );

    const logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl: API_URL },
      options,
    );

    expect(logs).to.have.lengthOf(PAGE_SIZE + 5);
  });

  it('returns an empty set when the explorer reports no records', async () => {
    fetchStub.resolves(noRecordsResponse());

    const logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl: API_URL },
      options,
    );

    expect(logs).to.deep.equal([]);
    expect(fetchStub.callCount).to.equal(1);
  });

  it('returns an empty set when the first page is empty', async () => {
    fetchStub.resolves(okResponse([]));

    const logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl: API_URL },
      options,
    );

    expect(logs).to.deep.equal([]);
    expect(fetchStub.callCount).to.equal(1);
  });

  // Trusting a success that carries no record list would turn the page already
  // read into a complete set.
  it('rejects a success whose payload is not a record list', async () => {
    fetchStub.onCall(0).resolves(okResponse(rawLogPage(PAGE_SIZE)));
    fetchStub.onCall(1).resolves(okResponse('No logs found'));

    let thrown: unknown;
    try {
      await getLogsFromEtherscanLikeExplorerAPI({ apiUrl: API_URL }, options);
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).to.include('carrying no record list');
    // Not a confirmed pagination problem, so it stays retryable.
    expect(thrown).to.not.have.property('isRecoverable');
  });

  it('keeps a transient later-page failure retryable', async () => {
    fetchStub.onCall(0).resolves(okResponse(rawLogPage(PAGE_SIZE)));
    fetchStub.onCall(1).resolves(rateLimitedResponse());

    let thrown: unknown;
    try {
      await getLogsFromEtherscanLikeExplorerAPI({ apiUrl: API_URL }, options);
    } catch (error) {
      thrown = error;
    }

    // Marking this unrecoverable would skip the retry that usually clears it
    // and start a full RPC scan instead.
    expect(thrown).to.not.have.property('isRecoverable');
    expect(String(thrown)).to.include('Max rate limit reached');
  });

  it('terminates on a no-records page reported with either recognized message', async () => {
    fetchStub.onCall(0).resolves(okResponse(rawLogPage(PAGE_SIZE)));
    fetchStub.onCall(1).resolves(noRecordsResponse('No records found'));

    const logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl: API_URL },
      options,
    );

    expect(logs).to.have.lengthOf(PAGE_SIZE);
  });
});
