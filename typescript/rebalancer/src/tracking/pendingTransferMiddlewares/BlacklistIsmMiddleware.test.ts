import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'ethers';
import { type Logger, pino } from 'pino';
import Sinon from 'sinon';

import {
  BlacklistIsm__factory,
  DomainRoutingIsm__factory,
  IInterchainSecurityModule__factory,
  MailboxClient__factory,
  Mailbox__factory,
  StaticAggregationIsm__factory,
} from '@hyperlane-xyz/core';
import {
  type DerivedIsmConfig,
  EvmIsmReader,
  type IsmConfig,
  IsmType,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import type {
  ExplorerMessage,
  IExplorerClient,
  UserTransferQueryParams,
} from '../../utils/ExplorerClient.js';

import {
  BLACKLIST_ISM_NO_BLOCKING_ROUTES_MESSAGE,
  BLACKLIST_ISM_REFRESH_FAILED_MESSAGE,
  BlacklistIsmMiddleware,
} from './BlacklistIsmMiddleware.js';
import { PENDING_TRANSFER_MIDDLEWARE_FAILED_MESSAGE } from './PendingTransferMiddleware.js';

chai.use(chaiAsPromised);

const ETHEREUM = 1;
const ARBITRUM = 42161;
const RADIX = 1633970780;
const CHAIN_NAMES: Record<number, string> = {
  [ETHEREUM]: 'ethereum',
  [ARBITRUM]: 'arbitrum',
  [RADIX]: 'radix',
};
const REFRESH_INTERVAL_MS = 600_000;

const MAILBOX = '0xc005dc82818d67af737725bd4bf75435d065d239';
const ROUTER = '0x67899664446ccfadf75e0d3f5668be262acd1069';
const ARBITRUM_ROUTER = '0x867a19a5b257bcb99e1840de2ef852268efd5e46';
const RADIX_ROUTER =
  '0x5d6b4e1a3c2f7e8d9b0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f';
const OWNER = '0x995a921d333029512aa166885856c8af760e9381';

const AGGREGATION_ISM = '0xa076bf16992ef5e54a52b4002e3a1b5353a5f14f';
const INNER_AGGREGATION_ISM = '0x7777777777777777777777777777777777777777';
const BLACKLIST_ISM = '0x435e9f0e54af1e0c37a6075233059f7625f2cfc9';
const SECOND_BLACKLIST_ISM = '0x3333333333333333333333333333333333333333';
const ARBITRUM_BLACKLIST_ISM = '0x6666666666666666666666666666666666666666';
const ROUTING_ISM = '0x1111111111111111111111111111111111111111';
const MULTISIG_ISM = '0x2222222222222222222222222222222222222222';
const PAUSABLE_ISM = '0x52d10c47e9e4a20e4561271a8440e32c44c00f45';
const DEFAULT_ISM = '0x4444444444444444444444444444444444444444';
const MAILBOX_DEFAULT_ISM = '0x5555555555555555555555555555555555555555';

const BLACKLISTED_ID =
  '0x8960c5e41eb0d91973140ebc196892f5f07f512dd86047e8536e71424462c5d3';
const CLEAN_ID =
  '0xdae65a8dd678bf8ea03faed7d53b99e52f5bdbae7c95834eff009cc37a18103c';

const mailboxInterface = Mailbox__factory.createInterface();
const blacklistInterface = BlacklistIsm__factory.createInterface();
const ismInterface = IInterchainSecurityModule__factory.createInterface();
const aggregationInterface = StaticAggregationIsm__factory.createInterface();
const routingInterface = DomainRoutingIsm__factory.createInterface();
const errorStringInterface = new ethers.utils.Interface([
  'function Error(string)',
]);

const MODULE_TYPE = { ROUTING: 1, AGGREGATION: 2, MULTISIG: 5, NULL: 6 };
const MODULE_TYPE_SELECTOR = ismInterface.getSighash('moduleType');
const MODULE_SELECTOR = routingInterface.getSighash('module');
const mailboxClientInterface = MailboxClient__factory.createInterface();
const MAILBOX_SELECTOR = mailboxClientInterface.getSighash('mailbox');

const VALUES_SELECTOR = blacklistInterface.getSighash('values');

const PARAMS: UserTransferQueryParams = {
  routersByDomain: { [ETHEREUM]: ROUTER, [ARBITRUM]: ARBITRUM_ROUTER },
  excludeTxSenders: [],
};

const EXPECTED_REASON = `Blacklisted by a BlacklistIsm (${BLACKLIST_ISM}) in the ISM of router ${ROUTER} on domain ${ETHEREUM}`;
const THIRD_ID =
  '0x1c3b5f0e2d4a6c8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70';

function blacklist(address: string, ids: string[] = []): DerivedIsmConfig {
  return {
    type: IsmType.BLACKLIST,
    address,
    owner: OWNER,
    blacklistedIds: ids,
  };
}

function multisig(address: string): DerivedIsmConfig {
  return {
    type: IsmType.MESSAGE_ID_MULTISIG,
    address,
    validators: [OWNER],
    threshold: 1,
  };
}

function aggregation(
  address: string,
  modules: IsmConfig[],
  threshold: number,
): DerivedIsmConfig {
  return { type: IsmType.AGGREGATION, address, modules, threshold };
}

function domainRouting(
  type:
    | typeof IsmType.ROUTING
    | typeof IsmType.INCREMENTAL_ROUTING
    | typeof IsmType.FALLBACK_ROUTING,
  address: string,
  domains: Record<string, IsmConfig>,
): DerivedIsmConfig {
  return { type, address, owner: OWNER, domains };
}

function mailboxDefaultWrapper(address: string): DerivedIsmConfig {
  return { type: IsmType.MAILBOX_DEFAULT, address };
}

/** The incident ISM: mailbox default wrapper, BlacklistIsm and PausableIsm. */
function incidentIsm(
  threshold: number,
  blacklistedIds = [BLACKLISTED_ID],
): DerivedIsmConfig {
  return aggregation(
    AGGREGATION_ISM,
    [
      mailboxDefaultWrapper(DEFAULT_ISM),
      blacklist(BLACKLIST_ISM, blacklistedIds),
      {
        type: IsmType.PAUSABLE,
        address: PAUSABLE_ISM,
        owner: OWNER,
        paused: false,
      },
    ],
    threshold,
  );
}

type BlockTag = ethers.providers.BlockTag;
type CallHandler = (data: string, blockTag: BlockTag | undefined) => string;

/** Answers eth_call by contract address and selector. */
class FakeChain {
  readonly provider = new ethers.providers.StaticJsonRpcProvider(
    'http://127.0.0.1:1',
    { chainId: ETHEREUM, name: 'fake' },
  );
  /** `${to}:${selector}` of every call, in order. */
  readonly calls: string[] = [];
  /** Origins passed to `module(origin)`, in order. */
  readonly routedOrigins: number[] = [];
  /** Block tags of every `values()` call, in order. */
  readonly valuesBlockTags: Array<BlockTag | undefined> = [];
  /** Thrown by every `values()` call at the finalized block when set. */
  finalizedError: Error | undefined;
  private readonly handlers = new Map<string, CallHandler>();
  private readonly recipientIsms = new Map<string, string>();

  constructor() {
    Sinon.stub(this.provider, 'call').callsFake(async (tx, blockTag) => {
      const { to, data } = await ethers.utils.resolveProperties(tx);
      if (typeof to !== 'string' || typeof data !== 'string') {
        throw new Error('Unexpected call');
      }

      const key = `${to.toLowerCase()}:${data.slice(0, 10)}`;
      this.calls.push(key);

      const handler = this.handlers.get(key);
      if (!handler) throw new Error(`Unexpected call ${key}`);

      return handler(data, await blockTag);
    });
  }

  on(address: string, selector: string, handler: CallHandler): void {
    this.handlers.set(`${address.toLowerCase()}:${selector}`, handler);
  }

  recipientIsm(router: string, ism: string): void {
    this.recipientIsms.set(router, ism);
    this.on(MAILBOX, mailboxInterface.getSighash('recipientIsm'), (data) => {
      const [recipient] = mailboxInterface.decodeFunctionData(
        'recipientIsm',
        data,
      );
      const routerIsm = this.recipientIsms.get(String(recipient).toLowerCase());
      if (!routerIsm) throw new Error(`Unexpected recipient ${recipient}`);

      return mailboxInterface.encodeFunctionResult('recipientIsm', [routerIsm]);
    });
  }

  defaultIsm(ism: string, mailbox = MAILBOX): void {
    this.on(mailbox, mailboxInterface.getSighash('defaultIsm'), () =>
      mailboxInterface.encodeFunctionResult('defaultIsm', [ism]),
    );
  }

  /** The mailbox a wrapper or mailbox client reports. */
  mailboxOf(ism: string, mailbox = MAILBOX): void {
    this.on(ism, MAILBOX_SELECTOR, () =>
      mailboxClientInterface.encodeFunctionResult('mailbox', [mailbox]),
    );
  }

  moduleType(address: string, moduleType: number): void {
    this.on(address, MODULE_TYPE_SELECTOR, () =>
      ismInterface.encodeFunctionResult('moduleType', [moduleType]),
    );
  }

  aggregationIsm(address: string, modules: string[], threshold: number): void {
    this.moduleType(address, MODULE_TYPE.AGGREGATION);
    this.on(
      address,
      aggregationInterface.getSighash('modulesAndThreshold'),
      () =>
        aggregationInterface.encodeFunctionResult('modulesAndThreshold', [
          modules,
          threshold,
        ]),
    );
  }

  /** A domain routing ISM; `module(origin)` reverts for an unset origin. */
  domainRoutingIsm(address: string, modules: Record<number, string>): void {
    this.moduleType(address, MODULE_TYPE.ROUTING);
    this.on(address, MODULE_SELECTOR, (data) => {
      const [origin] = routingInterface.decodeFunctionData('module', data);
      this.routedOrigins.push(Number(origin));

      const module = modules[Number(origin)];
      return module
        ? routingInterface.encodeFunctionResult('module', [module])
        : errorStringInterface.encodeFunctionData('Error', [
            `No ISM found for origin: ${origin}`,
          ]);
    });
  }

  /** A contract without the selector: the call returns no data. */
  missingSelector(address: string, selector: string): void {
    this.on(address, selector, () => '0x');
  }

  /**
   * Serves the BlacklistIsm's `values()`: `ids` at the finalized block and
   * `latestIds` at the latest one.
   */
  blacklist(address: string, ids: string[], latestIds = ids): void {
    this.on(address, VALUES_SELECTOR, (_data, blockTag) => {
      this.valuesBlockTags.push(blockTag);
      if (blockTag === 'finalized') {
        if (this.finalizedError) throw this.finalizedError;
        return blacklistInterface.encodeFunctionResult('values', [ids]);
      }
      if (blockTag === undefined || blockTag === 'latest') {
        return blacklistInterface.encodeFunctionResult('values', [latestIds]);
      }

      throw new Error(`Unexpected block tag ${blockTag}`);
    });
  }

  /** Serves `values()` for every BlacklistIsm in `config` with its ids. */
  blacklistsIn(config: IsmConfig): void {
    if (typeof config === 'string') return;

    switch (config.type) {
      case IsmType.BLACKLIST:
        if ('address' in config && typeof config.address === 'string') {
          this.blacklist(config.address, config.blacklistedIds);
        }
        return;
      case IsmType.AGGREGATION:
      case IsmType.STORAGE_AGGREGATION:
        config.modules.forEach((module) => this.blacklistsIn(module));
        return;
      case IsmType.ROUTING:
      case IsmType.INCREMENTAL_ROUTING:
      case IsmType.FALLBACK_ROUTING:
        Object.values(config.domains).forEach((module) =>
          this.blacklistsIn(module),
        );
        return;
      default:
        return;
    }
  }
}

function buildMessage(
  msgId: string,
  origin = ARBITRUM,
  destination = ETHEREUM,
): ExplorerMessage {
  return {
    msg_id: msgId,
    origin_domain_id: origin,
    destination_domain_id: destination,
    sender: ARBITRUM_ROUTER,
    recipient: ROUTER,
    origin_tx_hash:
      '0x5e3c1f6a3c1a7f86e0f2d5e9c9c1b8d1e1e7e2b6c4d8a9f0e1d2c3b4a5968778',
    origin_tx_sender: OWNER,
    origin_tx_recipient: ARBITRUM_ROUTER,
    is_delivered: false,
    message_body: `0x${'00'.repeat(64)}`,
    send_occurred_at: null,
  };
}

describe('BlacklistIsmMiddleware', () => {
  let chain: FakeChain;
  let clock: Sinon.SinonFakeTimers;
  let logger: Logger;
  let warn: Sinon.SinonSpy;
  let info: Sinon.SinonSpy;
  let derivedConfigs: Map<string, DerivedIsmConfig>;
  let deriveIsmConfig: Sinon.SinonStub<[string], Promise<DerivedIsmConfig>>;
  let explorerMessages: ExplorerMessage[];
  const inner: IExplorerClient = {
    getInflightUserTransfers: async () => explorerMessages,
    getInflightRebalanceActions: async () => [],
  };

  beforeEach(() => {
    chain = new FakeChain();
    chain.recipientIsm(ARBITRUM_ROUTER, MULTISIG_ISM);
    clock = Sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    logger = pino({ level: 'silent' });
    warn = Sinon.spy(logger, 'warn');
    info = Sinon.spy(logger, 'info');
    explorerMessages = [];

    derivedConfigs = new Map([[MULTISIG_ISM, multisig(MULTISIG_ISM)]]);
    chain.defaultIsm(MAILBOX_DEFAULT_ISM);
    chain.moduleType(MAILBOX_DEFAULT_ISM, MODULE_TYPE.MULTISIG);
    chain.moduleType(MULTISIG_ISM, MODULE_TYPE.MULTISIG);
    chain.mailboxOf(DEFAULT_ISM);
    chain.mailboxOf(ROUTING_ISM);
    deriveIsmConfig = Sinon.stub(
      EvmIsmReader.prototype,
      'deriveIsmConfigFromAddress',
    ).callsFake(async (address) => {
      const config = derivedConfigs.get(address.toLowerCase());
      if (!config) throw new Error(`No derived config for ${address}`);

      return config;
    });
  });

  afterEach(() => {
    clock.restore();
    deriveIsmConfig.restore();
  });

  /** The chain and ISM address of every startup derivation, in order. */
  function derivations(): Array<[unknown, string]> {
    return deriveIsmConfig
      .getCalls()
      .map((call) => [call.thisValue['chain'], call.args[0]]);
  }

  /**
   * Registers a derived config, with its BlacklistIsms reporting the same ids
   * at the finalized block.
   */
  function derivedIsm(config: DerivedIsmConfig): void {
    derivedConfigs.set(config.address.toLowerCase(), config);
    chain.blacklistsIn(config);
  }

  /** Registers a derived config and points the router at it. */
  function routerIsm(router: string, config: DerivedIsmConfig): void {
    derivedIsm(config);
    chain.recipientIsm(router, config.address);
  }

  /** Makes the mailbox default ISM a 1-of-1 aggregation of a BlacklistIsm. */
  function defaultIsmWithBlacklist(): void {
    chain.aggregationIsm(MAILBOX_DEFAULT_ISM, [BLACKLIST_ISM], 1);
    chain.moduleType(BLACKLIST_ISM, MODULE_TYPE.NULL);
    derivedIsm(blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]));
  }

  /** Gives the route a second pair whose ISM can block, so startup succeeds. */
  function blockingArbitrumIsm(): void {
    routerIsm(ARBITRUM_ROUTER, blacklist(ARBITRUM_BLACKLIST_ISM));
    chain.blacklist(ARBITRUM_BLACKLIST_ISM, []);
  }

  function createMiddleware(): Promise<BlacklistIsmMiddleware> {
    const multiProvider = Sinon.createStubInstance(MultiProvider);
    multiProvider.getProtocol.callsFake((domain) =>
      domain === RADIX ? ProtocolType.Radix : ProtocolType.Ethereum,
    );
    multiProvider.getChainName.callsFake(
      (domain) => CHAIN_NAMES[Number(domain)],
    );
    multiProvider.getProvider.returns(chain.provider);
    // EvmIsmReader's constructor reads chain metadata and explorer settings.
    multiProvider.getChainMetadata.callsFake((chainName) => ({
      name: String(chainName),
      chainId: ETHEREUM,
      domainId: ETHEREUM,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'http://127.0.0.1:1' }],
    }));
    multiProvider.tryGetEvmExplorerMetadataList.returns([]);

    return BlacklistIsmMiddleware.create(
      inner,
      {
        refreshIntervalMs: REFRESH_INTERVAL_MS,
        routersByDomain: {
          [ETHEREUM]: ROUTER,
          [ARBITRUM]: ARBITRUM_ROUTER,
          [RADIX]: RADIX_ROUTER,
        },
        mailboxByDomain: { [ETHEREUM]: MAILBOX, [ARBITRUM]: MAILBOX },
        multiProvider,
      },
      logger,
    );
  }

  async function createMiddlewareAndCountCalls(): Promise<{
    middleware: BlacklistIsmMiddleware;
    callsAfterInit: number;
  }> {
    const middleware = await createMiddleware();

    return { middleware, callsAfterInit: chain.calls.length };
  }

  /** The `values()` calls made since `start`, in order. */
  function valuesCallsSince(start: number): string[] {
    return chain.calls
      .slice(start)
      .filter((call) => call.endsWith(`:${VALUES_SELECTOR}`));
  }

  /** Ids of `messages` the middleware drops when the Explorer returns them. */
  async function queryIgnoredIds(
    middleware: BlacklistIsmMiddleware,
    messages: ExplorerMessage[],
  ): Promise<string[]> {
    explorerMessages = messages;
    const kept = await middleware.getInflightUserTransfers(PARAMS, logger);
    const keptIds = new Set(kept.map((msg) => msg.msg_id));

    expect(
      warn.calledWith(
        Sinon.match.any,
        PENDING_TRANSFER_MIDDLEWARE_FAILED_MESSAGE,
      ),
    ).to.be.false;

    return messages.map((msg) => msg.msg_id).filter((id) => !keptIds.has(id));
  }

  function expectIgnoredWithReason(messageId: string, reason: string): void {
    expect(
      info.calledWith(
        Sinon.match({ msgId: messageId, reason }),
        'Ignoring pending transfer',
      ),
    ).to.be.true;
  }

  it('ignores a message blacklisted in a 3-of-3 aggregation with no runtime RPC', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
      buildMessage(CLEAN_ID, RADIX),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(middleware.isIgnored(BLACKLISTED_ID)).to.be.true;
    expectIgnoredWithReason(BLACKLISTED_ID, EXPECTED_REASON);
    expect(chain.calls).to.have.lengthOf(callsAfterInit);
    expect(warn.called).to.be.false;
  });

  it('drops a 2-of-3 aggregation the BlacklistIsm cannot block on its own', async () => {
    routerIsm(ROUTER, incidentIsm(2));
    blockingArbitrumIsm();
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();

    clock.tick(REFRESH_INTERVAL_MS);
    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
    ]);

    expect(ignored).to.deep.equal([]);
    expect(valuesCallsSince(callsAfterInit)).to.deep.equal([
      `${ARBITRUM_BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ]);
  });

  interface NestedCase {
    name: string;
    innerThreshold: number;
    ignored: boolean;
  }
  const nestedCases: NestedCase[] = [
    {
      name: 'drops a nested 1-of-2 subtree whose BlacklistIsm cannot block',
      innerThreshold: 1,
      ignored: false,
    },
    {
      name: 'keeps a nested 2-of-2 subtree whose BlacklistIsm can block',
      innerThreshold: 2,
      ignored: true,
    },
  ];
  for (const c of nestedCases) {
    it(c.name, async () => {
      routerIsm(
        ROUTER,
        aggregation(
          AGGREGATION_ISM,
          [
            multisig(MULTISIG_ISM),
            aggregation(
              INNER_AGGREGATION_ISM,
              [
                blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
                multisig(MULTISIG_ISM),
              ],
              c.innerThreshold,
            ),
          ],
          2,
        ),
      );
      blockingArbitrumIsm();
      const middleware = await createMiddleware();

      const ignored = await queryIgnoredIds(middleware, [
        buildMessage(BLACKLISTED_ID),
      ]);

      expect(ignored.includes(BLACKLISTED_ID)).to.equal(c.ignored);
    });
  }

  it('ignores a message one mandatory BlacklistIsm among several rejects', async () => {
    routerIsm(
      ROUTER,
      aggregation(
        AGGREGATION_ISM,
        [
          multisig(MULTISIG_ISM),
          blacklist(BLACKLIST_ISM),
          blacklist(SECOND_BLACKLIST_ISM, [BLACKLISTED_ID]),
        ],
        3,
      ),
    );
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expectIgnoredWithReason(
      BLACKLISTED_ID,
      `Blacklisted by a BlacklistIsm (${BLACKLIST_ISM}, ${SECOND_BLACKLIST_ISM}) in the ISM of router ${ROUTER} on domain ${ETHEREUM}`,
    );
  });

  it('ignores a message in one BlacklistIsm of a 2-of-2 aggregation of BlacklistIsms', async () => {
    routerIsm(
      ROUTER,
      aggregation(
        AGGREGATION_ISM,
        [
          blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
          blacklist(SECOND_BLACKLIST_ISM),
        ],
        2,
      ),
    );
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
  });

  it('counts copies of one BlacklistIsm together in an aggregation', async () => {
    routerIsm(
      ROUTER,
      aggregation(
        AGGREGATION_ISM,
        [
          blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
          blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
          multisig(MULTISIG_ISM),
        ],
        2,
      ),
    );
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
  });

  it('shares one BlacklistIsm that blocks through only one of its branches', async () => {
    const secondInnerAggregation = '0x8888888888888888888888888888888888888888';
    routerIsm(
      ROUTER,
      aggregation(
        AGGREGATION_ISM,
        [
          aggregation(
            INNER_AGGREGATION_ISM,
            [
              blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
              multisig(MULTISIG_ISM),
            ],
            1,
          ),
          aggregation(
            secondInnerAggregation,
            [
              blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
              multisig(MULTISIG_ISM),
            ],
            2,
          ),
        ],
        2,
      ),
    );
    chain.blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]);
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();

    clock.tick(REFRESH_INTERVAL_MS);
    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(valuesCallsSince(callsAfterInit)).to.deep.equal([
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ]);
  });

  it('treats BlacklistIsms that only block together as never blocking', async () => {
    routerIsm(
      ROUTER,
      aggregation(
        AGGREGATION_ISM,
        [
          multisig(MULTISIG_ISM),
          blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
          blacklist(SECOND_BLACKLIST_ISM, [BLACKLISTED_ID]),
        ],
        2,
      ),
    );
    blockingArbitrumIsm();
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
    ]);

    expect(ignored).to.deep.equal([]);
  });

  it('fails to initialize when no route pair has a BlacklistIsm that can block', async () => {
    routerIsm(ROUTER, incidentIsm(2));

    const result = createMiddleware();

    await expect(result).to.be.rejectedWith(
      'No route pair has a BlacklistIsm that can block a message; remove the blacklistIsm pending transfer middleware',
    );
  });

  interface RoutingCase {
    type: typeof IsmType.ROUTING | typeof IsmType.INCREMENTAL_ROUTING;
  }
  const routingCases: RoutingCase[] = [
    { type: IsmType.ROUTING },
    { type: IsmType.INCREMENTAL_ROUTING },
  ];
  for (const c of routingCases) {
    it(`skips and warns about a pair a ${c.type} has no module for`, async () => {
      routerIsm(
        ROUTER,
        domainRouting(c.type, ROUTING_ISM, {
          arbitrum: blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
        }),
      );
      const middleware = await createMiddleware();

      expect(warn.callCount).to.equal(1);
      expect(warn.firstCall.args).to.deep.equal([
        {
          router: ROUTER,
          destination: ETHEREUM,
          origin: RADIX,
          routingIsm: ROUTING_ISM,
        },
        'Routing ISM has no module for origin, skipping BlacklistIsm check for this route pair',
      ]);

      const fromRadix = await queryIgnoredIds(middleware, [
        buildMessage(BLACKLISTED_ID, RADIX),
      ]);

      expect(fromRadix).to.deep.equal([]);

      const fromArbitrum = await queryIgnoredIds(middleware, [
        buildMessage(BLACKLISTED_ID, ARBITRUM),
      ]);

      expect(fromArbitrum).to.deep.equal([BLACKLISTED_ID]);
    });
  }

  it('uses the mailbox default ISM for an origin a fallback routing ISM does not list', async () => {
    routerIsm(
      ROUTER,
      domainRouting(IsmType.FALLBACK_ROUTING, ROUTING_ISM, {
        arbitrum: multisig(MULTISIG_ISM),
      }),
    );
    defaultIsmWithBlacklist();
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, RADIX),
      buildMessage(CLEAN_ID, ARBITRUM),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(warn.called).to.be.false;
    expect(derivations()).to.not.deep.include([
      'ethereum',
      ethers.utils.getAddress(MAILBOX_DEFAULT_ISM),
    ]);
  });

  it('uses the listed module of a fallback routing ISM', async () => {
    routerIsm(
      ROUTER,
      domainRouting(IsmType.FALLBACK_ROUTING, ROUTING_ISM, {
        arbitrum: blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
        radix: multisig(MULTISIG_ISM),
      }),
    );
    const middleware = await createMiddleware();

    const fromArbitrum = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, ARBITRUM),
    ]);
    const fromRadix = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, RADIX),
    ]);

    expect(fromArbitrum).to.deep.equal([BLACKLISTED_ID]);
    expect(fromRadix).to.deep.equal([]);
    expect(chain.calls).to.not.include(
      `${MAILBOX_DEFAULT_ISM}:${MODULE_TYPE_SELECTOR}`,
    );
  });

  interface NestedFallbackCase {
    name: string;
    routerConfig: () => DerivedIsmConfig;
  }
  const nestedFallbackCases: NestedFallbackCase[] = [
    {
      name: 'inside an aggregation',
      routerConfig: () =>
        aggregation(
          AGGREGATION_ISM,
          [
            multisig(MULTISIG_ISM),
            domainRouting(IsmType.FALLBACK_ROUTING, ROUTING_ISM, {
              arbitrum: multisig(MULTISIG_ISM),
            }),
          ],
          2,
        ),
    },
    {
      name: 'routed to by a domain routing ISM',
      routerConfig: () =>
        domainRouting(IsmType.ROUTING, INNER_AGGREGATION_ISM, {
          arbitrum: multisig(MULTISIG_ISM),
          radix: domainRouting(IsmType.FALLBACK_ROUTING, ROUTING_ISM, {
            arbitrum: multisig(MULTISIG_ISM),
          }),
        }),
    },
  ];
  for (const c of nestedFallbackCases) {
    it(`uses the mailbox default ISM for a fallback routing ISM ${c.name}`, async () => {
      routerIsm(ROUTER, c.routerConfig());
      defaultIsmWithBlacklist();
      const middleware = await createMiddleware();

      const ignored = await queryIgnoredIds(middleware, [
        buildMessage(BLACKLISTED_ID, RADIX),
        buildMessage(CLEAN_ID, ARBITRUM),
      ]);

      expect(ignored).to.deep.equal([BLACKLISTED_ID]);
      expect(chain.calls).to.include(
        `${MAILBOX_DEFAULT_ISM}:${MODULE_TYPE_SELECTOR}`,
      );
    });
  }

  it('fails to initialize when the mailbox default ISM falls back to itself', async () => {
    routerIsm(
      ROUTER,
      domainRouting(IsmType.FALLBACK_ROUTING, ROUTING_ISM, {
        arbitrum: blacklist(BLACKLIST_ISM),
      }),
    );
    // A default fallback routing ISM returns the mailbox default for an
    // unset origin, which is itself.
    chain.domainRoutingIsm(MAILBOX_DEFAULT_ISM, {
      [ARBITRUM]: MULTISIG_ISM,
      [RADIX]: MAILBOX_DEFAULT_ISM,
    });

    const result = createMiddleware();

    await expect(result).to.be.rejectedWith(
      `Failed to resolve the ISM of router ${ROUTER} on domain ${ETHEREUM}: Mailbox default ISM ${MAILBOX_DEFAULT_ISM} loops back to itself for radix`,
    );
  });

  it("reads only the route's branches of a domain routing mailbox default ISM", async () => {
    const modules: Record<number, string> = {
      [ARBITRUM]: AGGREGATION_ISM,
      [RADIX]: MULTISIG_ISM,
    };
    for (let domain = 1_000; domain < 1_150; domain++) {
      modules[domain] = MULTISIG_ISM;
    }
    chain.recipientIsm(ROUTER, MAILBOX_DEFAULT_ISM);
    chain.domainRoutingIsm(MAILBOX_DEFAULT_ISM, modules);
    chain.aggregationIsm(AGGREGATION_ISM, [MULTISIG_ISM, BLACKLIST_ISM], 2);
    chain.moduleType(BLACKLIST_ISM, MODULE_TYPE.NULL);
    derivedIsm(blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]));
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, ARBITRUM),
      buildMessage(CLEAN_ID, RADIX),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(chain.routedOrigins).to.deep.equal([ARBITRUM, RADIX]);
    expect(derivations()).to.deep.equal([
      ['ethereum', ethers.utils.getAddress(BLACKLIST_ISM)],
      ['arbitrum', ethers.utils.getAddress(MULTISIG_ISM)],
    ]);
  });

  it('skips a pair the domain routing mailbox default ISM has no module for', async () => {
    chain.recipientIsm(ROUTER, MAILBOX_DEFAULT_ISM);
    chain.domainRoutingIsm(MAILBOX_DEFAULT_ISM, { [ARBITRUM]: BLACKLIST_ISM });
    chain.moduleType(BLACKLIST_ISM, MODULE_TYPE.NULL);
    derivedIsm(blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]));
    const middleware = await createMiddleware();

    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args).to.deep.equal([
      {
        router: ROUTER,
        destination: ETHEREUM,
        origin: RADIX,
        routingIsm: MAILBOX_DEFAULT_ISM,
      },
      'Routing ISM has no module for origin, skipping BlacklistIsm check for this route pair',
    ]);

    const fromRadix = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, RADIX),
    ]);
    const fromArbitrum = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, ARBITRUM),
    ]);

    expect(fromRadix).to.deep.equal([]);
    expect(fromArbitrum).to.deep.equal([BLACKLISTED_ID]);
  });

  it('fails to initialize when the mailbox default ISM cannot be read', async () => {
    chain.recipientIsm(ROUTER, MAILBOX_DEFAULT_ISM);
    chain.moduleType(MAILBOX_DEFAULT_ISM, MODULE_TYPE.ROUTING);
    chain.on(MAILBOX_DEFAULT_ISM, MODULE_SELECTOR, () => {
      throw new Error('rpc unavailable');
    });

    const result = createMiddleware();

    await expect(result).to.be.rejectedWith(
      `Failed to resolve the ISM of router ${ROUTER} on domain ${ETHEREUM}: rpc unavailable`,
    );
  });

  it('uses the mailbox default ISM behind a mailbox default ISM wrapper', async () => {
    routerIsm(
      ROUTER,
      aggregation(
        AGGREGATION_ISM,
        [mailboxDefaultWrapper(DEFAULT_ISM), multisig(MULTISIG_ISM)],
        2,
      ),
    );
    chain.aggregationIsm(MAILBOX_DEFAULT_ISM, [MULTISIG_ISM, BLACKLIST_ISM], 2);
    chain.moduleType(BLACKLIST_ISM, MODULE_TYPE.NULL);
    derivedIsm(blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]));
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
      buildMessage(CLEAN_ID),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(
      derivations().filter(([chainName]) => chainName === 'ethereum'),
    ).to.deep.equal([
      ['ethereum', ethers.utils.getAddress(AGGREGATION_ISM)],
      ['ethereum', ethers.utils.getAddress(BLACKLIST_ISM)],
    ]);
  });

  it('treats a routing ISM without module() in the mailbox default ISM as never blocking, with no further reads', async () => {
    const amountRoutingIsm = '0x9999999999999999999999999999999999999999';
    chain.recipientIsm(ROUTER, MAILBOX_DEFAULT_ISM);
    chain.aggregationIsm(
      MAILBOX_DEFAULT_ISM,
      [amountRoutingIsm, BLACKLIST_ISM],
      2,
    );
    chain.moduleType(amountRoutingIsm, MODULE_TYPE.ROUTING);
    chain.missingSelector(amountRoutingIsm, MODULE_SELECTOR);
    chain.moduleType(BLACKLIST_ISM, MODULE_TYPE.NULL);
    derivedIsm(blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]));
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
      buildMessage(CLEAN_ID),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(
      chain.calls.filter((call) => call.startsWith(amountRoutingIsm)),
    ).to.have.members([
      `${amountRoutingIsm}:${MODULE_TYPE_SELECTOR}`,
      `${amountRoutingIsm}:${MODULE_SELECTOR}`,
      `${amountRoutingIsm}:${MODULE_SELECTOR}`,
    ]);
    expect(derivations().map(([, address]) => address)).to.not.include(
      ethers.utils.getAddress(amountRoutingIsm),
    );
  });

  interface WrapperMailboxCase {
    name: string;
    routerConfig: () => DerivedIsmConfig;
    wrapper: string;
  }
  const wrapperMailboxCases: WrapperMailboxCase[] = [
    {
      name: 'a mailbox default ISM wrapper',
      routerConfig: () =>
        aggregation(
          AGGREGATION_ISM,
          [mailboxDefaultWrapper(DEFAULT_ISM), multisig(MULTISIG_ISM)],
          2,
        ),
      wrapper: DEFAULT_ISM,
    },
    {
      name: 'a fallback routing ISM without the origin',
      routerConfig: () =>
        domainRouting(IsmType.FALLBACK_ROUTING, ROUTING_ISM, {}),
      wrapper: ROUTING_ISM,
    },
  ];
  for (const c of wrapperMailboxCases) {
    it(`follows the mailbox of ${c.name} bound to another mailbox`, async () => {
      const otherMailbox = '0xd4c1905bb1d26bc93dac913e13cacc278cdcc80d';
      const otherDefaultIsm = '0x7777777777777777777777777777777777777770';
      routerIsm(ROUTER, c.routerConfig());
      chain.mailboxOf(c.wrapper, otherMailbox);
      chain.defaultIsm(otherDefaultIsm, otherMailbox);
      chain.aggregationIsm(otherDefaultIsm, [BLACKLIST_ISM], 1);
      chain.moduleType(BLACKLIST_ISM, MODULE_TYPE.NULL);
      derivedIsm(blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]));
      const middleware = await createMiddleware();

      const ignored = await queryIgnoredIds(middleware, [
        buildMessage(BLACKLISTED_ID),
        buildMessage(CLEAN_ID),
      ]);

      expect(ignored).to.deep.equal([BLACKLISTED_ID]);
      expect(chain.calls).to.not.include(
        `${MAILBOX_DEFAULT_ISM}:${MODULE_TYPE_SELECTOR}`,
      );
    });
  }

  /** A routing ISM that has a module for arbitrum only, so radix is unrouted. */
  function arbitrumOnlyRouting(): DerivedIsmConfig {
    return domainRouting(IsmType.ROUTING, ROUTING_ISM, {
      arbitrum: multisig(MULTISIG_ISM),
    });
  }

  interface UnroutedCase {
    name: string;
    routerConfig: () => DerivedIsmConfig;
  }
  const unroutedBlockingCases: UnroutedCase[] = [
    {
      name: 'an unrouted branch that an inner aggregation can do without',
      routerConfig: () =>
        aggregation(
          AGGREGATION_ISM,
          [
            blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
            aggregation(
              INNER_AGGREGATION_ISM,
              [multisig(MULTISIG_ISM), arbitrumOnlyRouting()],
              1,
            ),
          ],
          2,
        ),
    },
    {
      name: 'an unrouted module in a 2-of-3 aggregation',
      routerConfig: () =>
        aggregation(
          AGGREGATION_ISM,
          [
            blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
            multisig(MULTISIG_ISM),
            arbitrumOnlyRouting(),
          ],
          2,
        ),
    },
  ];
  for (const c of unroutedBlockingCases) {
    it(`still checks the BlacklistIsm next to ${c.name}`, async () => {
      routerIsm(ROUTER, c.routerConfig());
      const middleware = await createMiddleware();

      const ignored = await queryIgnoredIds(middleware, [
        buildMessage(BLACKLISTED_ID, RADIX),
        buildMessage(CLEAN_ID, RADIX),
      ]);

      expect(ignored).to.deep.equal([BLACKLISTED_ID]);
      expect(warn.called).to.be.false;
    });
  }

  it('skips a pair whose ISM always rejects because of an unrouted module', async () => {
    routerIsm(
      ROUTER,
      aggregation(
        AGGREGATION_ISM,
        [blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]), arbitrumOnlyRouting()],
        2,
      ),
    );
    const middleware = await createMiddleware();

    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args).to.deep.equal([
      {
        router: ROUTER,
        destination: ETHEREUM,
        origin: RADIX,
        routingIsm: ROUTING_ISM,
      },
      'Routing ISM has no module for origin, skipping BlacklistIsm check for this route pair',
    ]);

    const fromRadix = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, RADIX),
    ]);
    const fromArbitrum = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, ARBITRUM),
    ]);

    expect(fromRadix).to.deep.equal([]);
    expect(fromArbitrum).to.deep.equal([BLACKLISTED_ID]);
  });

  interface OpaqueCase {
    name: string;
    module: IsmConfig;
  }
  const opaqueCases: OpaqueCase[] = [
    {
      name: 'an amount routing ISM',
      module: {
        type: IsmType.AMOUNT_ROUTING,
        lowerIsm: blacklist(SECOND_BLACKLIST_ISM, [BLACKLISTED_ID]),
        upperIsm: blacklist(SECOND_BLACKLIST_ISM, [BLACKLISTED_ID]),
        threshold: 100,
      },
    },
    {
      name: 'an interchain account routing ISM',
      module: {
        type: IsmType.INTERCHAIN_ACCOUNT_ROUTING,
        owner: OWNER,
        isms: { arbitrum: SECOND_BLACKLIST_ISM },
      },
    },
    { name: 'a plain address entry', module: SECOND_BLACKLIST_ISM },
  ];
  for (const c of opaqueCases) {
    it(`treats ${c.name} as never blocking`, async () => {
      routerIsm(
        ROUTER,
        aggregation(AGGREGATION_ISM, [c.module, blacklist(BLACKLIST_ISM)], 2),
      );
      const middleware = await createMiddleware();

      const ignored = await queryIgnoredIds(middleware, [
        buildMessage(BLACKLISTED_ID),
      ]);

      expect(ignored).to.deep.equal([]);
    });
  }

  it('fails to initialize with context when an ISM cannot be derived', async () => {
    chain.recipientIsm(ROUTER, AGGREGATION_ISM);

    const result = createMiddleware();

    await expect(result).to.be.rejectedWith(
      `Failed to resolve the ISM of router ${ROUTER} on domain ${ETHEREUM}: No derived config for ${ethers.utils.getAddress(AGGREGATION_ISM)}`,
    );
  });

  it('fails to initialize when the mailbox cannot be read', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    chain.on(MAILBOX, mailboxInterface.getSighash('recipientIsm'), () => {
      throw new Error('rpc unavailable');
    });

    const result = createMiddleware();

    await expect(result).to.be.rejectedWith(
      `Failed to resolve the ISM of router ${ROUTER} on domain ${ETHEREUM}: rpc unavailable`,
    );
  });

  it('derives each destination ISM once, not once per origin', async () => {
    routerIsm(ROUTER, incidentIsm(3));

    await createMiddleware();

    expect(derivations()).to.deep.equal([
      ['ethereum', ethers.utils.getAddress(AGGREGATION_ISM)],
      ['arbitrum', ethers.utils.getAddress(MULTISIG_ISM)],
    ]);
  });

  it('never resolves a non-EVM destination', async () => {
    routerIsm(ROUTER, incidentIsm(3));

    await createMiddleware();

    expect(derivations().map(([chainName]) => chainName)).to.not.include(
      'radix',
    );
    expect(
      chain.calls.filter(
        (call) =>
          call === `${MAILBOX}:${mailboxInterface.getSighash('recipientIsm')}`,
      ),
    ).to.have.lengthOf(2);
  });

  it('keeps a message that blacklisted ids do not cover', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [buildMessage(CLEAN_ID)]);

    expect(ignored).to.deep.equal([]);
  });

  it('makes no RPC calls for pairs without a BlacklistIsm or non-EVM destinations', async () => {
    routerIsm(ROUTER, multisig(MULTISIG_ISM));
    blockingArbitrumIsm();
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, ARBITRUM, ETHEREUM),
      buildMessage(BLACKLISTED_ID, RADIX, ETHEREUM),
      buildMessage(BLACKLISTED_ID, ETHEREUM, RADIX),
    ]);

    expect(ignored).to.deep.equal([]);
    expect(chain.calls).to.have.lengthOf(callsAfterInit);
  });

  it('re-derives the ISM graph only once the refresh interval passes', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    chain.blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]);
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();
    const messages = [buildMessage(BLACKLISTED_ID)];

    await queryIgnoredIds(middleware, messages);

    expect(chain.calls).to.have.lengthOf(callsAfterInit);
    expect(deriveIsmConfig.callCount).to.equal(2);

    clock.tick(REFRESH_INTERVAL_MS);
    await queryIgnoredIds(middleware, messages);

    expect(valuesCallsSince(callsAfterInit)).to.deep.equal([
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ]);
    expect(deriveIsmConfig.callCount).to.equal(4);
  });

  interface RemovalCase {
    name: string;
    before: DerivedIsmConfig;
    after: DerivedIsmConfig;
  }
  const removalCases: RemovalCase[] = [
    {
      name: 'is removed from an aggregation',
      before: incidentIsm(3),
      after: aggregation(
        AGGREGATION_ISM,
        [mailboxDefaultWrapper(DEFAULT_ISM), multisig(MULTISIG_ISM)],
        2,
      ),
    },
    {
      name: 'is replaced by DomainRoutingIsm.set',
      before: domainRouting(IsmType.ROUTING, ROUTING_ISM, {
        arbitrum: blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
        radix: multisig(MULTISIG_ISM),
      }),
      after: domainRouting(IsmType.ROUTING, ROUTING_ISM, {
        arbitrum: multisig(MULTISIG_ISM),
        radix: multisig(MULTISIG_ISM),
      }),
    },
    {
      name: 'leaves the router ISM',
      before: incidentIsm(3),
      after: multisig(MULTISIG_ISM),
    },
  ];
  for (const c of removalCases) {
    it(`stops ignoring a message once its BlacklistIsm ${c.name}`, async () => {
      routerIsm(ROUTER, c.before);
      blockingArbitrumIsm();
      const middleware = await createMiddleware();
      const messages = [buildMessage(BLACKLISTED_ID)];

      expect(await queryIgnoredIds(middleware, messages)).to.deep.equal([
        BLACKLISTED_ID,
      ]);

      routerIsm(ROUTER, c.after);
      clock.tick(REFRESH_INTERVAL_MS - 1);

      expect(await queryIgnoredIds(middleware, messages)).to.deep.equal([
        BLACKLISTED_ID,
      ]);

      clock.tick(1);
      const ignored = await queryIgnoredIds(middleware, messages);

      expect(ignored).to.deep.equal([]);
      expect(middleware.isIgnored(BLACKLISTED_ID)).to.be.false;
      expect(warn.called).to.be.false;
    });
  }

  it('picks up a route pair gaining its first BlacklistIsm after startup', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    const middleware = await createMiddleware();
    const messages = [buildMessage(CLEAN_ID, ETHEREUM, ARBITRUM)];

    expect(await queryIgnoredIds(middleware, messages)).to.deep.equal([]);

    routerIsm(ARBITRUM_ROUTER, blacklist(ARBITRUM_BLACKLIST_ISM, [CLEAN_ID]));
    clock.tick(REFRESH_INTERVAL_MS);
    const ignored = await queryIgnoredIds(middleware, messages);

    expect(ignored).to.deep.equal([CLEAN_ID]);
    expectIgnoredWithReason(
      CLEAN_ID,
      `Blacklisted by a BlacklistIsm (${ARBITRUM_BLACKLIST_ISM}) in the ISM of router ${ARBITRUM_ROUTER} on domain ${ARBITRUM}`,
    );
  });

  it('picks up an id blacklisted after startup once the refresh interval passes', async () => {
    routerIsm(ROUTER, incidentIsm(3, []));
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();
    chain.blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]);
    const messages = [buildMessage(BLACKLISTED_ID)];

    clock.tick(REFRESH_INTERVAL_MS - 1);
    const withinInterval = await queryIgnoredIds(middleware, messages);

    expect(withinInterval).to.deep.equal([]);
    expect(chain.calls).to.have.lengthOf(callsAfterInit);

    clock.tick(1);
    const ignored = await queryIgnoredIds(middleware, messages);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(valuesCallsSince(callsAfterInit)).to.deep.equal([
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ]);
  });

  it('refreshes every pair at most once per interval, whatever the batch', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    chain.blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]);
    blockingArbitrumIsm();
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();
    const everyPairRead = [
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
      `${ARBITRUM_BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ];

    clock.tick(REFRESH_INTERVAL_MS);
    await queryIgnoredIds(middleware, []);
    const callsAfterRefresh = chain.calls.length;

    expect(valuesCallsSince(callsAfterInit)).to.have.members(everyPairRead);
    expect(deriveIsmConfig.callCount).to.equal(4);

    clock.tick(REFRESH_INTERVAL_MS - 1);
    await queryIgnoredIds(middleware, [buildMessage(CLEAN_ID)]);
    await queryIgnoredIds(middleware, [
      buildMessage(CLEAN_ID, ETHEREUM, ARBITRUM),
    ]);

    expect(chain.calls).to.have.lengthOf(callsAfterRefresh);

    clock.tick(1);
    await queryIgnoredIds(middleware, [
      buildMessage(CLEAN_ID, ETHEREUM, ARBITRUM),
    ]);

    expect(valuesCallsSince(callsAfterRefresh)).to.have.members(everyPairRead);
    expect(deriveIsmConfig.callCount).to.equal(6);
  });

  it('reads a BlacklistIsm shared by pairs once on refresh and updates every pair', async () => {
    routerIsm(ROUTER, incidentIsm(3, []));
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();
    chain.blacklist(BLACKLIST_ISM, [BLACKLISTED_ID, THIRD_ID]);

    clock.tick(REFRESH_INTERVAL_MS);
    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID, ARBITRUM),
      buildMessage(THIRD_ID, RADIX),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID, THIRD_ID]);
    expect(valuesCallsSince(callsAfterInit)).to.deep.equal([
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ]);
  });

  it('keeps every old id when one read of a refresh fails, until a later refresh succeeds', async () => {
    routerIsm(
      ROUTER,
      aggregation(
        AGGREGATION_ISM,
        [
          multisig(MULTISIG_ISM),
          blacklist(BLACKLIST_ISM),
          blacklist(SECOND_BLACKLIST_ISM, [BLACKLISTED_ID]),
        ],
        3,
      ),
    );
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();
    chain.blacklist(BLACKLIST_ISM, [CLEAN_ID]);
    chain.on(SECOND_BLACKLIST_ISM, VALUES_SELECTOR, () => {
      throw new Error('rpc unavailable');
    });
    const messages = [
      buildMessage(BLACKLISTED_ID),
      buildMessage(CLEAN_ID),
      buildMessage(THIRD_ID),
    ];

    clock.tick(REFRESH_INTERVAL_MS);
    const ignored = await queryIgnoredIds(middleware, messages);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args).to.deep.equal([
      {
        destination: ETHEREUM,
        error: `Failed to read the blacklisted ids of BlacklistIsm ${SECOND_BLACKLIST_ISM} on domain ${ETHEREUM}: rpc unavailable`,
      },
      BLACKLIST_ISM_REFRESH_FAILED_MESSAGE,
    ]);

    chain.blacklist(SECOND_BLACKLIST_ISM, [BLACKLISTED_ID, THIRD_ID]);
    clock.tick(REFRESH_INTERVAL_MS);
    const retried = await queryIgnoredIds(middleware, messages);

    expect(retried).to.deep.equal([BLACKLISTED_ID, CLEAN_ID, THIRD_ID]);
    expect(warn.callCount).to.equal(1);
    expect(valuesCallsSince(callsAfterInit)).to.have.members([
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
      `${SECOND_BLACKLIST_ISM}:${VALUES_SELECTOR}`,
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
      `${SECOND_BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ]);
  });

  it('keeps the old routes of a destination whose refresh fails and applies the others', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    routerIsm(ARBITRUM_ROUTER, blacklist(ARBITRUM_BLACKLIST_ISM, [CLEAN_ID]));
    const middleware = await createMiddleware();
    const messages = [
      buildMessage(BLACKLISTED_ID),
      buildMessage(THIRD_ID),
      buildMessage(CLEAN_ID, ETHEREUM, ARBITRUM),
    ];

    expect(await queryIgnoredIds(middleware, messages)).to.deep.equal([
      BLACKLISTED_ID,
      CLEAN_ID,
    ]);

    derivedConfigs.delete(AGGREGATION_ISM);
    chain.blacklist(BLACKLIST_ISM, [BLACKLISTED_ID, THIRD_ID]);
    routerIsm(ARBITRUM_ROUTER, multisig(MULTISIG_ISM));
    clock.tick(REFRESH_INTERVAL_MS);
    const ignored = await queryIgnoredIds(middleware, messages);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args).to.deep.equal([
      {
        destination: ETHEREUM,
        error: `Failed to resolve the ISM of router ${ROUTER} on domain ${ETHEREUM}: No derived config for ${ethers.utils.getAddress(AGGREGATION_ISM)}`,
      },
      BLACKLIST_ISM_REFRESH_FAILED_MESSAGE,
    ]);

    routerIsm(ROUTER, incidentIsm(3, [BLACKLISTED_ID, THIRD_ID]));
    clock.tick(REFRESH_INTERVAL_MS);
    const recovered = await queryIgnoredIds(middleware, messages);

    expect(recovered).to.deep.equal([BLACKLISTED_ID, THIRD_ID]);
    expect(warn.callCount).to.equal(1);
  });

  it('ignores nothing and warns when a refresh finds no BlacklistIsm that can block', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    const middleware = await createMiddleware();
    const messages = [buildMessage(BLACKLISTED_ID)];

    routerIsm(ROUTER, multisig(MULTISIG_ISM));
    clock.tick(REFRESH_INTERVAL_MS);
    const ignored = await queryIgnoredIds(middleware, messages);

    expect(ignored).to.deep.equal([]);
    expect(middleware.isIgnored(BLACKLISTED_ID)).to.be.false;
    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args).to.deep.equal([
      BLACKLIST_ISM_NO_BLOCKING_ROUTES_MESSAGE,
    ]);
  });

  it('keeps the last known ids and warns once when a refresh fails', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();
    chain.on(BLACKLIST_ISM, VALUES_SELECTOR, () => {
      throw new Error('rpc unavailable');
    });
    const messages = [buildMessage(BLACKLISTED_ID)];

    clock.tick(REFRESH_INTERVAL_MS * 2);
    const ignored = await queryIgnoredIds(middleware, messages);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(warn.callCount).to.equal(1);
    const [fields, message] = warn.firstCall.args;
    expect(message).to.equal(BLACKLIST_ISM_REFRESH_FAILED_MESSAGE);
    expect(fields).to.deep.equal({
      destination: ETHEREUM,
      error: `Failed to read the blacklisted ids of BlacklistIsm ${BLACKLIST_ISM} on domain ${ETHEREUM}: rpc unavailable`,
    });

    clock.tick(REFRESH_INTERVAL_MS - 1);
    const beforeRetry = await queryIgnoredIds(middleware, messages);

    expect(beforeRetry).to.deep.equal([BLACKLISTED_ID]);
    expect(warn.callCount).to.equal(1);
    expect(valuesCallsSince(callsAfterInit)).to.deep.equal([
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ]);

    chain.blacklist(BLACKLIST_ISM, [BLACKLISTED_ID, CLEAN_ID]);
    clock.tick(1);
    const afterRetry = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
      buildMessage(CLEAN_ID),
    ]);

    expect(afterRetry).to.deep.equal([BLACKLISTED_ID, CLEAN_ID]);
    expect(valuesCallsSince(callsAfterInit)).to.deep.equal([
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ]);
  });

  it('does not seed an id blacklisted at the latest block but not at the finalized one', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    chain.blacklist(BLACKLIST_ISM, [], [BLACKLISTED_ID]);
    const middleware = await createMiddleware();

    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
    ]);

    expect(ignored).to.deep.equal([]);
  });

  it('ignores an id only once it is blacklisted at the finalized block', async () => {
    routerIsm(ROUTER, incidentIsm(3, []));
    const middleware = await createMiddleware();
    const messages = [buildMessage(BLACKLISTED_ID)];

    chain.blacklist(BLACKLIST_ISM, [], [BLACKLISTED_ID]);
    clock.tick(REFRESH_INTERVAL_MS);
    const unfinalized = await queryIgnoredIds(middleware, messages);

    expect(unfinalized).to.deep.equal([]);

    // Reorged out before finality: latest drops it, finalized never had it.
    chain.blacklist(BLACKLIST_ISM, [], []);
    clock.tick(REFRESH_INTERVAL_MS);
    const reorged = await queryIgnoredIds(middleware, messages);

    expect(reorged).to.deep.equal([]);

    chain.blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]);
    clock.tick(REFRESH_INTERVAL_MS);
    const finalized = await queryIgnoredIds(middleware, messages);

    expect(finalized).to.deep.equal([BLACKLISTED_ID]);
    expect(warn.called).to.be.false;
  });

  it('reads every BlacklistIsm at the finalized block, at startup and on refresh', async () => {
    routerIsm(
      ROUTER,
      aggregation(
        AGGREGATION_ISM,
        [
          blacklist(BLACKLIST_ISM, [BLACKLISTED_ID]),
          blacklist(SECOND_BLACKLIST_ISM, [THIRD_ID]),
        ],
        2,
      ),
    );
    const middleware = await createMiddleware();

    expect(chain.valuesBlockTags).to.deep.equal(['finalized', 'finalized']);

    clock.tick(REFRESH_INTERVAL_MS);
    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
      buildMessage(THIRD_ID),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID, THIRD_ID]);
    expect(chain.valuesBlockTags).to.deep.equal([
      'finalized',
      'finalized',
      'finalized',
      'finalized',
    ]);
  });

  it('fails to initialize when a BlacklistIsm cannot be read at the finalized block', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    chain.finalizedError = new Error('finalized block tag not supported');

    const result = createMiddleware();

    await expect(result).to.be.rejectedWith(
      `Failed to read the blacklisted ids of BlacklistIsm ${BLACKLIST_ISM} on domain ${ETHEREUM}: finalized block tag not supported`,
    );
  });

  it('keeps the last known ids and warns when a finalized read fails on refresh', async () => {
    routerIsm(ROUTER, incidentIsm(3));
    const { middleware, callsAfterInit } =
      await createMiddlewareAndCountCalls();
    chain.blacklist(BLACKLIST_ISM, [BLACKLISTED_ID, CLEAN_ID]);
    chain.finalizedError = new Error('finalized block tag not supported');

    clock.tick(REFRESH_INTERVAL_MS);
    const ignored = await queryIgnoredIds(middleware, [
      buildMessage(BLACKLISTED_ID),
      buildMessage(CLEAN_ID),
    ]);

    expect(ignored).to.deep.equal([BLACKLISTED_ID]);
    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args[1]).to.equal(
      BLACKLIST_ISM_REFRESH_FAILED_MESSAGE,
    );
    expect(warn.firstCall.args[0]).to.deep.equal({
      destination: ETHEREUM,
      error: `Failed to read the blacklisted ids of BlacklistIsm ${BLACKLIST_ISM} on domain ${ETHEREUM}: finalized block tag not supported`,
    });
    expect(valuesCallsSince(callsAfterInit)).to.deep.equal([
      `${BLACKLIST_ISM}:${VALUES_SELECTOR}`,
    ]);
    expect(chain.valuesBlockTags.slice(-1)).to.deep.equal(['finalized']);
  });
});
