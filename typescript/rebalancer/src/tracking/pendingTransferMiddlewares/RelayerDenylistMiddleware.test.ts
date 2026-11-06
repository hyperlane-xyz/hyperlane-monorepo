import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Logger, pino } from 'pino';
import Sinon from 'sinon';

import type {
  ExplorerMessage,
  IExplorerClient,
  UserTransferQueryParams,
} from '../../utils/ExplorerClient.js';

import { PENDING_TRANSFER_MIDDLEWARE_FAILED_MESSAGE } from './PendingTransferMiddleware.js';
import {
  RELAYER_DENYLIST_CHECK_FAILED_MESSAGE,
  RELAYER_DENYLIST_REFRESH_FAILED_MESSAGE,
  RelayerDenylistMiddleware,
  fetchDenylistFile,
  redactUrl,
} from './RelayerDenylistMiddleware.js';
import {
  DenylistLoadError,
  DenylistLoadFailure,
} from './relayerDenylistRules.js';

chai.use(chaiAsPromised);

const MESSAGE_ID =
  '0x8960c5e41eb0d91973140ebc196892f5f07f512dd86047e8536e71424462c5d3';
const OTHER_MESSAGE_ID =
  '0xdae65a8dd678bf8ea03faed7d53b99e52f5bdbae7c95834eff009cc37a18103c';
const URL_WITH_TOKEN = 'https://example.com/denylist.json?token=secret#frag';
const URL_WITH_CREDENTIALS = 'https://user:hunter2@example.com/denylist.json';
const REFRESH_INTERVAL_MS = 60_000;

const PARAMS: UserTransferQueryParams = {
  routersByDomain: { 1: '0x67899664446ccfadf75e0d3f5668be262acd1069' },
  excludeTxSenders: [],
};

const INVALID_REGEX_FILE = JSON.stringify({
  rules: [
    {
      reason: 'r',
      addedBy: 'a',
      match: { originDomain: 1, bodyRegex: '(' },
    },
  ],
});

function buildMessage(msgId: string): ExplorerMessage {
  return {
    msg_id: msgId,
    origin_domain_id: 42161,
    destination_domain_id: 1,
    sender: '0x867a19a5b257bcb99e1840de2ef852268efd5e46',
    recipient: '0x67899664446ccfadf75e0d3f5668be262acd1069',
    origin_tx_hash:
      '0x5e3c1f6a3c1a7f86e0f2d5e9c9c1b8d1e1e7e2b6c4d8a9f0e1d2c3b4a5968778',
    origin_tx_sender: '0x995a921d333029512aa166885856c8af760e9381',
    origin_tx_recipient: '0x867a19a5b257bcb99e1840de2ef852268efd5e46',
    is_delivered: false,
    message_body: `0x${'00'.repeat(64)}`,
    send_occurred_at: null,
  };
}

function denylistFor(messageIds: string[]): string {
  return JSON.stringify({
    rules: messageIds.map((messageId) => ({
      reason: 'stuck',
      addedBy: 'tester',
      match: { messageId },
    })),
  });
}

describe('RelayerDenylistMiddleware', () => {
  let clock: Sinon.SinonFakeTimers;
  let dir: string;
  let denylistPath: string;
  let denylistUrl: string;
  let fetchStub: Sinon.SinonStub | undefined;
  let explorerMessages: ExplorerMessage[];
  const inner: IExplorerClient = {
    getInflightUserTransfers: async () => explorerMessages,
    getInflightRebalanceActions: async () => [],
  };
  let logger: Logger;
  let warn: Sinon.SinonSpy;
  let info: Sinon.SinonSpy;
  const messages = [buildMessage(MESSAGE_ID), buildMessage(OTHER_MESSAGE_ID)];

  beforeEach(() => {
    clock = Sinon.useFakeTimers({
      now: Date.parse('2026-11-04T00:00:00Z'),
      toFake: ['Date'],
    });
    dir = mkdtempSync(join(tmpdir(), 'relayer-denylist-'));
    denylistPath = join(dir, 'denylist.json');
    denylistUrl = pathToFileURL(denylistPath).href;
    logger = pino({ level: 'silent' });
    warn = Sinon.spy(logger, 'warn');
    info = Sinon.spy(logger, 'info');
    explorerMessages = messages;
  });

  afterEach(() => {
    clock.restore();
    fetchStub?.restore();
    fetchStub = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDenylist(text: string): void {
    writeFileSync(denylistPath, text);
  }

  function createMiddleware(
    url = denylistUrl,
  ): Promise<RelayerDenylistMiddleware> {
    return RelayerDenylistMiddleware.create(
      inner,
      { url, refreshIntervalMs: REFRESH_INTERVAL_MS },
      logger,
    );
  }

  /** Ids of the Explorer messages the middleware drops from the query. */
  async function queryIgnoredIds(
    middleware: RelayerDenylistMiddleware,
  ): Promise<string[]> {
    const kept = await middleware.getInflightUserTransfers(PARAMS, logger);
    const keptIds = new Set(kept.map((msg) => msg.msg_id));

    expect(
      warn.calledWith(
        Sinon.match.any,
        PENDING_TRANSFER_MIDDLEWARE_FAILED_MESSAGE,
      ),
    ).to.be.false;

    return explorerMessages
      .map((msg) => msg.msg_id)
      .filter((id) => !keptIds.has(id));
  }

  it('redacts credentials, query and fragment from URLs', () => {
    const redacted = redactUrl(`${URL_WITH_CREDENTIALS}?token=secret#frag`);

    expect(redacted).to.equal('https://example.com/denylist.json');
  });

  it('rejects a URL with credentials without printing them', async () => {
    fetchStub = Sinon.stub(globalThis, 'fetch');

    const result = createMiddleware(URL_WITH_CREDENTIALS);

    await expect(result).to.be.rejectedWith(
      'Relayer denylist url https://example.com/denylist.json must not contain credentials',
    );
    expect(fetchStub.called).to.be.false;
  });

  it('ignores the messages the loaded rules deny', async () => {
    writeDenylist(denylistFor([MESSAGE_ID]));
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware);

    expect(ignored).to.deep.equal([MESSAGE_ID]);
    expect(middleware.isIgnored(MESSAGE_ID)).to.be.true;
    expect(
      info.calledWith(
        Sinon.match({ msgId: MESSAGE_ID, reason: 'stuck (added by tester)' }),
        'Ignoring pending transfer',
      ),
    ).to.be.true;
  });

  it('loads the denylist over https', async () => {
    fetchStub = Sinon.stub(globalThis, 'fetch').resolves(
      new Response(denylistFor([OTHER_MESSAGE_ID])),
    );
    const middleware = await createMiddleware(URL_WITH_TOKEN);

    const ignored = await queryIgnoredIds(middleware);

    expect(ignored).to.deep.equal([OTHER_MESSAGE_ID]);
  });

  interface StartupFailureCase {
    name: string;
    response: () => Promise<Response>;
    failure: DenylistLoadFailure;
  }
  const startupFailures: StartupFailureCase[] = [
    {
      name: 'the fetch fails',
      response: () =>
        Promise.reject(new Error(`connect ECONNREFUSED ${URL_WITH_TOKEN}`)),
      failure: DenylistLoadFailure.FetchFailed,
    },
    {
      name: 'the file is invalid',
      response: async () => new Response('{"rules": [{}]}'),
      failure: DenylistLoadFailure.InvalidFile,
    },
    {
      name: 'a bodyRegex does not compile',
      response: async () => new Response(INVALID_REGEX_FILE),
      failure: DenylistLoadFailure.InvalidFile,
    },
  ];
  for (const c of startupFailures) {
    it(`fails to start with a redacted URL when ${c.name}`, async () => {
      fetchStub = Sinon.stub(globalThis, 'fetch').callsFake(c.response);

      const error = await createMiddleware(URL_WITH_TOKEN).then(
        () => expect.fail('Expected create to throw'),
        (err: unknown) => err,
      );

      expect(error).to.be.instanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).to.match(
          new RegExp(
            `^Failed to load relayer denylist from https://example\\.com/denylist\\.json \\(${c.failure}\\): `,
          ),
        );
        expect(error.message).to.not.include('secret');
      }
    });
  }

  it('refetches only once the refresh interval has passed', async () => {
    writeDenylist(denylistFor([MESSAGE_ID]));
    const middleware = await createMiddleware();
    writeDenylist(denylistFor([OTHER_MESSAGE_ID]));

    clock.tick(REFRESH_INTERVAL_MS - 1);
    const withinInterval = await queryIgnoredIds(middleware);

    expect(withinInterval).to.deep.equal([MESSAGE_ID]);

    clock.tick(1);
    const ignored = await queryIgnoredIds(middleware);

    expect(ignored).to.deep.equal([OTHER_MESSAGE_ID]);
  });

  interface RefreshFailureCase {
    name: string;
    breakDenylist: () => void;
    failure: DenylistLoadFailure;
  }
  const refreshFailures: RefreshFailureCase[] = [
    {
      name: 'fetch failure',
      breakDenylist: () => renameSync(denylistPath, `${denylistPath}.moved`),
      failure: DenylistLoadFailure.FetchFailed,
    },
    {
      name: 'invalid file',
      breakDenylist: () => writeDenylist('not json'),
      failure: DenylistLoadFailure.InvalidFile,
    },
    {
      name: 'a bodyRegex that does not compile',
      breakDenylist: () => writeDenylist(INVALID_REGEX_FILE),
      failure: DenylistLoadFailure.InvalidFile,
    },
  ];
  for (const c of refreshFailures) {
    it(`keeps the last good rules and warns on ${c.name}`, async () => {
      writeDenylist(denylistFor([MESSAGE_ID]));
      const middleware = await createMiddleware();
      c.breakDenylist();
      clock.tick(REFRESH_INTERVAL_MS * 2);

      const ignored = await queryIgnoredIds(middleware);

      expect(ignored).to.deep.equal([MESSAGE_ID]);
      expect(warn.callCount).to.equal(1);
      const [fields, message] = warn.firstCall.args;
      expect(message).to.equal(RELAYER_DENYLIST_REFRESH_FAILED_MESSAGE);
      expect(fields).to.include({
        url: denylistUrl,
        failure: c.failure,
        cachedRulesAgeSecs: 120,
      });
    });
  }

  it('redacts the URL and error of a failed https refresh', async () => {
    fetchStub = Sinon.stub(globalThis, 'fetch');
    fetchStub
      .onFirstCall()
      .resolves(new Response(denylistFor([MESSAGE_ID])))
      .onSecondCall()
      .rejects(new Error(`connect ECONNREFUSED ${URL_WITH_TOKEN}`));
    const middleware = await createMiddleware(URL_WITH_TOKEN);
    clock.tick(REFRESH_INTERVAL_MS);

    const ignored = await queryIgnoredIds(middleware);

    expect(ignored).to.deep.equal([MESSAGE_ID]);
    expect(warn.callCount).to.equal(1);
    const [fields, message] = warn.firstCall.args;
    expect(message).to.equal(RELAYER_DENYLIST_REFRESH_FAILED_MESSAGE);
    expect(fields).to.include({
      url: 'https://example.com/denylist.json',
      failure: DenylistLoadFailure.FetchFailed,
    });
    expect(fields.error).to.not.include('secret');
  });

  it('does not retry a failed refresh before the interval passes', async () => {
    writeDenylist(denylistFor([MESSAGE_ID]));
    const middleware = await createMiddleware();
    writeDenylist('not json');

    clock.tick(REFRESH_INTERVAL_MS);
    await queryIgnoredIds(middleware);
    writeDenylist(denylistFor([OTHER_MESSAGE_ID]));
    clock.tick(1);
    const ignored = await queryIgnoredIds(middleware);

    expect(warn.callCount).to.equal(1);
    expect(ignored).to.deep.equal([MESSAGE_ID]);
  });

  const unreadableSenders = [
    { name: 'a non-hex sender', sender: 'not-hex' },
    { name: 'a 20-byte zero sender', sender: `0x${'00'.repeat(20)}` },
  ];
  for (const c of unreadableSenders) {
    it(`keeps a message with ${c.name} and warns`, async () => {
      writeDenylist(denylistFor([MESSAGE_ID]));
      const middleware = await createMiddleware();
      const message: ExplorerMessage = {
        msg_id: MESSAGE_ID,
        origin_domain_id: 42161,
        destination_domain_id: 1,
        sender: c.sender,
        recipient: '0x67899664446ccfadf75e0d3f5668be262acd1069',
        origin_tx_hash: '0x00',
        origin_tx_sender: '0x995a921d333029512aa166885856c8af760e9381',
        origin_tx_recipient: '0x867a19a5b257bcb99e1840de2ef852268efd5e46',
        is_delivered: false,
        message_body: '0x',
        send_occurred_at: null,
      };
      explorerMessages = [message];

      const ignored = await queryIgnoredIds(middleware);

      expect(ignored).to.deep.equal([]);
      expect(warn.callCount).to.equal(1);
      const [fields, warning] = warn.firstCall.args;
      expect(fields).to.include({ msgId: MESSAGE_ID });
      expect(warning).to.equal(RELAYER_DENYLIST_CHECK_FAILED_MESSAGE);
    });
  }

  describe('fetchDenylistFile', () => {
    let dir: string;
    let fetchStub: Sinon.SinonStub | undefined;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'denylist-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      fetchStub?.restore();
      fetchStub = undefined;
    });

    it('reads file:// URLs', async () => {
      const path = join(dir, 'denylist.json');
      writeFileSync(path, denylistFor([MESSAGE_ID]));

      const text = await fetchDenylistFile(pathToFileURL(path));

      expect(text).to.equal(denylistFor([MESSAGE_ID]));
    });

    it('reads http(s):// URLs', async () => {
      fetchStub = Sinon.stub(globalThis, 'fetch').resolves(
        new Response(denylistFor([MESSAGE_ID])),
      );

      const text = await fetchDenylistFile(
        new URL('https://example.com/denylist.json'),
      );

      expect(text).to.equal(denylistFor([MESSAGE_ID]));
    });

    it('reports a missing file as a fetch failure', async () => {
      const result = fetchDenylistFile(
        pathToFileURL(join(dir, 'missing.json')),
      );

      await expect(result).to.be.rejected.and.eventually.have.property(
        'failure',
        DenylistLoadFailure.FetchFailed,
      );
    });

    it('keeps credentials out of the error when fetch rejects the URL', async () => {
      const error = await fetchDenylistFile(new URL(URL_WITH_CREDENTIALS)).then(
        () => expect.fail('Expected fetchDenylistFile to throw'),
        (err: unknown) => err,
      );

      expect(error).to.be.instanceOf(DenylistLoadError);
      if (error instanceof DenylistLoadError) {
        expect(error.failure).to.equal(DenylistLoadFailure.FetchFailed);
        expect(error.message).to.include('https://example.com/denylist.json');
        expect(error.message).to.not.include('hunter2');
        expect(error.message).to.not.include('user');
      }
    });

    it('keeps query tokens out of the error when fetch fails', async () => {
      fetchStub = Sinon.stub(globalThis, 'fetch').rejects(
        new Error(`connect ECONNREFUSED ${URL_WITH_TOKEN}`),
      );

      const error = await fetchDenylistFile(new URL(URL_WITH_TOKEN)).then(
        () => expect.fail('Expected fetchDenylistFile to throw'),
        (err: unknown) => err,
      );

      expect(error).to.be.instanceOf(DenylistLoadError);
      if (error instanceof DenylistLoadError) {
        expect(error.message).to.equal(
          'connect ECONNREFUSED https://example.com/denylist.json',
        );
      }
    });

    it('reports a non-2xx response as a fetch failure', async () => {
      fetchStub = Sinon.stub(globalThis, 'fetch').resolves(
        new Response('nope', { status: 404 }),
      );

      const result = fetchDenylistFile(
        new URL('https://example.com/denylist.json'),
      );

      await expect(result).to.be.rejected.and.eventually.have.property(
        'failure',
        DenylistLoadFailure.FetchFailed,
      );
    });

    it('reports an unsupported protocol as a fetch failure', async () => {
      const result = fetchDenylistFile(new URL('ftp://example.com/x.json'));

      await expect(result).to.be.rejectedWith(
        'Unsupported denylist URL protocol ftp:',
      );
    });
  });
});
