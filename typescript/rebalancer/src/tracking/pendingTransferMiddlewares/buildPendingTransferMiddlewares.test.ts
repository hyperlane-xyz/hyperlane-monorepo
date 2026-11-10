import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Logger, pino } from 'pino';
import Sinon from 'sinon';

import { MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import {
  type PendingTransferMiddlewareConfig,
  PendingTransferMiddlewareType,
} from '../../config/types.js';
import {
  ID_A,
  ID_B,
  ID_C,
  PARAMS,
  REBALANCE_PARAMS,
  StubExplorerClient,
  buildMessage,
} from '../../test/pendingTransferMiddlewareMocks.js';

import { INITIAL_LOAD_RETRY_DELAY_MS } from './RelayerDenylistMiddleware.js';
import {
  type PendingTransferMiddlewareDeps,
  buildPendingTransferMiddlewares,
} from './buildPendingTransferMiddlewares.js';

describe('buildPendingTransferMiddlewares', () => {
  const logger = pino({ level: 'silent' });
  let deps: PendingTransferMiddlewareDeps;

  beforeEach(() => {
    const multiProvider = Sinon.createStubInstance(MultiProvider);
    multiProvider.getProtocol.returns(ProtocolType.Ethereum);
    multiProvider.getProvider.throws(new Error('No provider in this test'));

    deps = {
      routersByDomain: { 1: '0x67899664446ccfadf75e0d3f5668be262acd1069' },
      mailboxByDomain: { 1: '0xc005dc82818d67af737725bd4bf75435d065d239' },
      multiProvider,
      logger,
    };
  });

  it('returns the inner client unchanged when no middlewares are configured', async () => {
    const inner = new StubExplorerClient([]);

    const result = await buildPendingTransferMiddlewares(inner, [], deps);

    expect(result.client).to.equal(inner);
    expect(result.isIgnoredTransfer).to.equal(undefined);
    expect(result.isIgnoredRebalanceAction).to.equal(undefined);
  });

  it('builds layers in config order and unions their ignored ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pending-transfer-middlewares-'));
    try {
      const writeDenylist = (name: string, ids: string[]): string => {
        const path = join(dir, `${name}.json`);
        writeFileSync(
          path,
          JSON.stringify({
            rules: ids.map((messageId) => ({
              reason: name,
              addedBy: 'tester',
              match: { messageId },
            })),
          }),
        );

        return pathToFileURL(path).href;
      };
      const configs: PendingTransferMiddlewareConfig[] = [
        {
          type: PendingTransferMiddlewareType.RelayerDenylist,
          url: writeDenylist('first', [ID_A, ID_B]),
          refreshIntervalSecs: 60,
        },
        {
          type: PendingTransferMiddlewareType.RelayerDenylist,
          url: writeDenylist('second', [ID_A]),
          refreshIntervalSecs: 60,
        },
      ];
      const inner = new StubExplorerClient([
        buildMessage(ID_A),
        buildMessage(ID_B),
        buildMessage(ID_C),
      ]);
      const queryLogger: Logger = pino({ level: 'silent' });
      const info = Sinon.spy(queryLogger, 'info');

      inner.rebalanceActions = [buildMessage(ID_B), buildMessage(ID_C)];

      const { client, isIgnoredTransfer, isIgnoredRebalanceAction } =
        await buildPendingTransferMiddlewares(inner, configs, deps);
      const result = await client.getInflightUserTransfers(PARAMS, queryLogger);
      const rebalanceActions = await client.getInflightRebalanceActions(
        REBALANCE_PARAMS,
        queryLogger,
      );

      expect(result.map((msg) => msg.msg_id)).to.deep.equal([ID_C]);

      // Item 0 is innermost, so it sees ID_A first and records its reason.
      const ignoredLogs = info
        .getCalls()
        .filter((call) => call.args.includes('Ignoring pending transfer'));
      expect(ignoredLogs).to.have.lengthOf(2);
      for (const id of [ID_A, ID_B]) {
        expect(
          info.calledWith(
            Sinon.match({ msgId: id, reason: 'first (added by tester)' }),
            'Ignoring pending transfer',
          ),
        ).to.be.true;
      }

      assert(isIgnoredTransfer, 'Expected an ignored-transfer predicate');
      expect(isIgnoredTransfer(ID_A)).to.be.true;
      expect(isIgnoredTransfer(ID_B)).to.be.true;
      expect(isIgnoredTransfer(ID_C)).to.be.false;

      expect(rebalanceActions.map((msg) => msg.msg_id)).to.deep.equal([
        ID_B,
        ID_C,
      ]);
      assert(
        isIgnoredRebalanceAction,
        'Expected an ignored-rebalance-action predicate',
      );
      expect(isIgnoredRebalanceAction(ID_B)).to.be.true;
      expect(isIgnoredRebalanceAction(ID_C)).to.be.false;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the BlacklistIsm trees cannot be resolved at startup', async () => {
    const inner = new StubExplorerClient([]);
    const configs: PendingTransferMiddlewareConfig[] = [
      {
        type: PendingTransferMiddlewareType.BlacklistIsm,
        refreshIntervalSecs: 600,
      },
    ];

    const error = await buildPendingTransferMiddlewares(
      inner,
      configs,
      deps,
    ).then(
      () => expect.fail('Expected buildPendingTransferMiddlewares to throw'),
      (err: unknown) => err,
    );

    expect(error).to.be.instanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).to.equal(
        'Failed to resolve the ISM of router 0x67899664446ccfadf75e0d3f5668be262acd1069 on domain 1: No provider in this test',
      );
    }
  });

  it('fails when a relayer denylist cannot be loaded at startup', async () => {
    const inner = new StubExplorerClient([]);
    const configs: PendingTransferMiddlewareConfig[] = [
      {
        type: PendingTransferMiddlewareType.RelayerDenylist,
        url: 'https://example.com/denylist.json',
        refreshIntervalSecs: 60,
      },
    ];
    // Startup retries a failed fetch after a delay; a stubbed fetch keeps
    // the faked delays off real I/O.
    const clock = Sinon.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
    });
    const fetchStub = Sinon.stub(globalThis, 'fetch').rejects(
      new Error('getaddrinfo ENOTFOUND example.com'),
    );
    try {
      const result = buildPendingTransferMiddlewares(inner, configs, deps).then(
        () => expect.fail('Expected buildPendingTransferMiddlewares to throw'),
        (err: unknown) => err,
      );
      await clock.tickAsync(2 * INITIAL_LOAD_RETRY_DELAY_MS);
      const error = await result;

      expect(error).to.be.instanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).to.equal(
          'Failed to load relayer denylist from https://example.com/denylist.json (fetch_failed): getaddrinfo ENOTFOUND example.com',
        );
      }
    } finally {
      fetchStub.restore();
      clock.restore();
    }
  });
});
