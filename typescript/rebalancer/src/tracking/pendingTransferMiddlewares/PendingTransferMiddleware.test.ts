import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { type Logger, pino } from 'pino';
import Sinon from 'sinon';

import { assert } from '@hyperlane-xyz/utils';

import type {
  ExplorerMessage,
  IExplorerClient,
  RebalanceActionQueryParams,
  UserTransferQueryParams,
} from '../../utils/ExplorerClient.js';
import {
  ID_A,
  ID_B,
  ID_C,
  PARAMS,
  StubExplorerClient,
  buildMessage,
} from '../../test/pendingTransferMiddlewareMocks.js';

import {
  MAX_EXPLORER_QUERY_LIMIT,
  PENDING_TRANSFER_MIDDLEWARE_FAILED_MESSAGE,
  PENDING_TRANSFER_MIDDLEWARE_QUERY_LIMIT_MESSAGE,
  PendingTransferMiddleware,
} from './PendingTransferMiddleware.js';

chai.use(chaiAsPromised);

/** Returns the first `limit` messages, newest first, like the Explorer. */
class PagedExplorerClient implements IExplorerClient {
  readonly limits: number[] = [];

  constructor(public newestFirst: ExplorerMessage[]) {}

  async getInflightUserTransfers(
    params: UserTransferQueryParams,
    _logger: Logger,
  ): Promise<ExplorerMessage[]> {
    assert(params.limit !== undefined, 'Expected an explicit limit');
    this.limits.push(params.limit);

    return this.newestFirst.slice(0, params.limit);
  }

  async getInflightRebalanceActions(
    _params: RebalanceActionQueryParams,
    _logger: Logger,
  ): Promise<ExplorerMessage[]> {
    return [];
  }
}

function messageId(index: number): string {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

/** Ignores a fixed set of ids and records what it was shown. */
class StaticMiddleware extends PendingTransferMiddleware {
  readonly seen: string[][] = [];

  constructor(
    inner: IExplorerClient,
    name: string,
    public ignoredIds: string[],
  ) {
    super(inner, name);
  }

  protected async findIgnored(
    messages: ExplorerMessage[],
  ): Promise<Map<string, string>> {
    this.seen.push(messages.map((msg) => msg.msg_id));
    const ignoredIds = new Set(this.ignoredIds);

    return new Map(
      messages
        .filter((msg) => ignoredIds.has(msg.msg_id))
        .map((msg) => [msg.msg_id, `${this.name} reason`]),
    );
  }
}

class ThrowingMiddleware extends PendingTransferMiddleware {
  constructor(inner: IExplorerClient) {
    super(inner, 'throwing');
  }

  protected async findIgnored(): Promise<Map<string, string>> {
    throw new Error('boom');
  }
}

describe('PendingTransferMiddleware', () => {
  let logger: Logger;
  let info: Sinon.SinonSpy;
  let warn: Sinon.SinonSpy;
  let inner: StubExplorerClient;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    info = Sinon.spy(logger, 'info');
    warn = Sinon.spy(logger, 'warn');
    inner = new StubExplorerClient([
      buildMessage(ID_A),
      buildMessage(ID_B),
      buildMessage(ID_C),
    ]);
  });

  it('chains middlewares so later ones only see what earlier ones kept', async () => {
    const innerLayer = new StaticMiddleware(inner, 'first', [ID_A]);
    const outerLayer = new StaticMiddleware(innerLayer, 'second', [ID_B]);

    const result = await outerLayer.getInflightUserTransfers(PARAMS, logger);

    expect(result.map((msg) => msg.msg_id)).to.deep.equal([ID_C]);
    expect(innerLayer.seen).to.deep.equal([[ID_A, ID_B, ID_C]]);
    expect(outerLayer.seen).to.deep.equal([[ID_B, ID_C]]);
    expect(innerLayer.isIgnored(ID_A)).to.be.true;
    expect(innerLayer.isIgnored(ID_B)).to.be.false;
    expect(outerLayer.isIgnored(ID_B.toUpperCase().replace('0X', '0x'))).to.be
      .true;
    expect(outerLayer.isIgnored(ID_A)).to.be.true;
    expect(outerLayer.isIgnored(ID_C)).to.be.false;
  });

  it('reports ids an inner middleware ignored through an outer one that ignores nothing', async () => {
    const innerLayer = new StaticMiddleware(inner, 'first', [ID_A]);
    const outerLayer = new StaticMiddleware(innerLayer, 'second', []);

    const result = await outerLayer.getInflightUserTransfers(PARAMS, logger);

    expect(result.map((msg) => msg.msg_id)).to.deep.equal([ID_B, ID_C]);
    expect(outerLayer.isIgnored(ID_A)).to.be.true;
    expect(outerLayer.isIgnored(ID_B)).to.be.false;
  });

  it('passes rebalance action queries through', async () => {
    const client = new StaticMiddleware(inner, 'all', [ID_C]);

    const result = await client.getInflightRebalanceActions(
      {
        bridges: [],
        routersByDomain: PARAMS.routersByDomain,
        rebalancerAddress: '0x995a921d333029512aa166885856c8af760e9381',
      },
      logger,
    );

    expect(result).to.equal(inner.rebalanceActions);
  });

  it('keeps every message and warns when the middleware throws', async () => {
    const client = new ThrowingMiddleware(inner);

    const result = await client.getInflightUserTransfers(PARAMS, logger);

    expect(result.map((msg) => msg.msg_id)).to.deep.equal([ID_A, ID_B, ID_C]);
    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args).to.deep.equal([
      { middleware: 'throwing', error: 'boom' },
      PENDING_TRANSFER_MIDDLEWARE_FAILED_MESSAGE,
    ]);
  });

  it('raises the limit it passes down by what each layer dropped', async () => {
    const innerLayer = new StaticMiddleware(inner, 'first', [ID_A]);
    const outerLayer = new StaticMiddleware(innerLayer, 'second', [ID_B]);

    await outerLayer.getInflightUserTransfers(PARAMS, logger);
    await outerLayer.getInflightUserTransfers(
      {
        routersByDomain: PARAMS.routersByDomain,
        excludeTxSenders: PARAMS.excludeTxSenders,
        limit: 10,
      },
      logger,
    );

    expect(
      inner.userTransferParams.map((params) => params.limit),
    ).to.deep.equal([100, 12]);
    expect(inner.userTransferParams[1].excludeTxSenders).to.deep.equal(
      PARAMS.excludeTxSenders,
    );
  });

  it('logs each ignored message once until it stops being ignored', async () => {
    const client = new StaticMiddleware(inner, 'first', [ID_A]);

    await client.getInflightUserTransfers(PARAMS, logger);
    await client.getInflightUserTransfers(PARAMS, logger);

    expect(info.callCount).to.equal(1);
    expect(info.firstCall.args).to.deep.equal([
      {
        msgId: ID_A,
        origin: 42161,
        destination: 1,
        amount: '100',
        middleware: 'first',
        reason: 'first reason',
      },
      'Ignoring pending transfer',
    ]);

    client.ignoredIds = [];
    const result = await client.getInflightUserTransfers(PARAMS, logger);

    expect(result).to.have.lengthOf(3);
    expect(client.isIgnored(ID_A)).to.be.false;
    expect(info.callCount).to.equal(2);
    expect(info.secondCall.args[1]).to.equal(
      'Pending transfer no longer ignored',
    );
  });
});

describe('PendingTransferMiddleware Explorer paging', () => {
  let logger: Logger;
  let warn: Sinon.SinonSpy;

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    warn = Sinon.spy(logger, 'warn');
  });

  function ignoredIds(count: number): string[] {
    return Array.from({ length: count }, (_, index) => messageId(index + 1));
  }

  it('re-queries with doubling limits until it keeps a transfer behind many ignored messages', async () => {
    const ignored = ignoredIds(1_000);
    const realTransfer = buildMessage(ID_A);
    const inner = new PagedExplorerClient([
      ...ignored.map(buildMessage),
      realTransfer,
    ]);
    const middleware = new StaticMiddleware(inner, 'paging', ignored);

    const result = await middleware.getInflightUserTransfers(PARAMS, logger);

    expect(result.map((msg) => msg.msg_id)).to.deep.equal([ID_A]);
    expect(inner.limits).to.deep.equal([100, 200, 400, 800, 1_600]);
    expect(middleware.isIgnored(messageId(1_000))).to.be.true;
    expect(warn.called).to.be.false;
  });

  it('stops once the Explorer returns fewer rows than asked', async () => {
    const ignored = ignoredIds(5);
    const inner = new PagedExplorerClient([
      ...ignored.map(buildMessage),
      buildMessage(ID_A),
    ]);
    const middleware = new StaticMiddleware(inner, 'paging', ignored);

    const result = await middleware.getInflightUserTransfers(
      {
        routersByDomain: PARAMS.routersByDomain,
        excludeTxSenders: PARAMS.excludeTxSenders,
        limit: 3,
      },
      logger,
    );

    expect(result.map((msg) => msg.msg_id)).to.deep.equal([ID_A]);
    expect(inner.limits).to.deep.equal([3, 6, 12]);
  });

  it('throws instead of returning a partial page past the row limit', async () => {
    const ignored = ignoredIds(MAX_EXPLORER_QUERY_LIMIT + 100);
    const inner = new PagedExplorerClient([
      ...ignored.map(buildMessage),
      buildMessage(ID_A),
    ]);
    const middleware = new StaticMiddleware(inner, 'paging', ignored);

    const result = middleware.getInflightUserTransfers(PARAMS, logger);

    await expect(result).to.be.rejectedWith(
      `${PENDING_TRANSFER_MIDDLEWARE_QUERY_LIMIT_MESSAGE} (middleware paging, requested 100, kept 0 of 25600 rows, limit 25600)`,
    );
    expect(inner.limits).to.deep.equal([
      100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800, 25_600,
    ]);
  });

  describe('after a query that ignored 13,000 transfers', () => {
    let inner: PagedExplorerClient;
    let middleware: StaticMiddleware;

    beforeEach(async () => {
      const ignored = ignoredIds(13_000);
      inner = new PagedExplorerClient([
        ...ignored.map(buildMessage),
        buildMessage(ID_A),
      ]);
      middleware = new StaticMiddleware(inner, 'paging', ignored);
      await middleware.getInflightUserTransfers(PARAMS, logger);
      inner.limits.length = 0;
    });

    it('raises the limit to the row cap rather than throwing', async () => {
      const ignored = ignoredIds(13_050);
      const realTransfers = Array.from({ length: 100 }, (_, index) =>
        messageId(1_000_000 + index),
      );
      inner.newestFirst = [
        ...ignored.map(buildMessage),
        ...realTransfers.map(buildMessage),
      ];
      middleware.ignoredIds = ignored;

      const result = await middleware.getInflightUserTransfers(PARAMS, logger);

      expect(result.map((msg) => msg.msg_id)).to.deep.equal(realTransfers);
      expect(inner.limits).to.deep.equal([13_100, 25_600]);
    });

    it('throws only after a full page at the row cap', async () => {
      const ignored = ignoredIds(MAX_EXPLORER_QUERY_LIMIT);
      inner.newestFirst = [...ignored.map(buildMessage), buildMessage(ID_A)];
      middleware.ignoredIds = ignored;

      const result = middleware.getInflightUserTransfers(PARAMS, logger);

      await expect(result).to.be.rejectedWith(
        `${PENDING_TRANSFER_MIDDLEWARE_QUERY_LIMIT_MESSAGE} (middleware paging, requested 100, kept 0 of 25600 rows, limit 25600)`,
      );
      expect(inner.limits).to.deep.equal([13_100, 25_600]);
    });
  });
});
