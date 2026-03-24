import { expect } from 'chai';
import { pino } from 'pino';
import { type Address, type Hex, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { HookType } from '@hyperlane-xyz/sdk';
import { TokenFeeType } from '@hyperlane-xyz/sdk';

import {
  EIP712_DOMAIN,
  SIGNED_QUOTE_TYPES,
  ZERO_ADDRESS,
} from '../../src/constants.js';
import {
  QuoteService,
  type ChainQuoteContext,
  type QuoteServiceOptions,
} from '../../src/services/quoteService.js';
import { QuotedCallsCommand } from '../../src/types.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
const TEST_SIGNER = TEST_ACCOUNT.address;

const QUOTED_CALLS = '0x4444444444444444444444444444444444444444' as Address;
const FEE_CONTRACT = '0x1111111111111111111111111111111111111111' as Address;
const IGP_ADDRESS = '0x2222222222222222222222222222222222222222' as Address;
const FEE_TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const ROUTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const RECIPIENT =
  '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const SALT =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;
const DESTINATION = 42161;

const mockMultiProvider = {
  getChainName: (d: number) => (d === 42161 ? 'arbitrum' : `chain-${d}`),
} as any;

const mockDerivedConfig = {
  hook: {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    address: IGP_ADDRESS,
    owner: ZERO_ADDRESS,
    beneficiary: ZERO_ADDRESS,
    oracleKey: ZERO_ADDRESS,
    overhead: {},
    oracleConfig: {},
    quoteSigners: [TEST_SIGNER],
  },
  tokenFee: {
    type: TokenFeeType.OffchainQuotedLinearFee,
    address: FEE_CONTRACT,
    token: FEE_TOKEN,
    owner: ZERO_ADDRESS,
    maxFee: 0n,
    halfAmount: 1n,
    bps: 0n,
    quoteSigners: [TEST_SIGNER],
  },
} as any;

function createTestContext(
  overrides?: Partial<ChainQuoteContext>,
): ChainQuoteContext {
  const routers = new Map();
  routers.set(ROUTER, {
    feeToken: FEE_TOKEN,
    derivedConfig: mockDerivedConfig,
  });
  return {
    chainId: 1,
    domainId: 1,
    chainName: 'ethereum',
    quotedCallsAddress: QUOTED_CALLS,
    multiProvider: mockMultiProvider,
    routers,
    ...overrides,
  };
}

function createTestService(
  overrides?: Partial<QuoteServiceOptions>,
): QuoteService {
  const chainContexts = new Map<string, ChainQuoteContext>();
  chainContexts.set('ethereum', createTestContext());
  return new QuoteService({
    signerKey: TEST_PRIVATE_KEY,
    quoteMode: 'transient',
    quoteExpiry: 300,
    chainContexts,
    logger: pino({ level: 'silent' }),
    ...overrides,
  });
}

describe('QuoteService', () => {
  describe('transient mode', () => {
    let service: QuoteService;
    beforeEach(() => {
      service = createTestService();
    });

    it('returns warp fee + IGP quotes', async () => {
      const res = await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      expect(res.quotes).to.be.an('array').with.lengthOf(2);
    });

    it('expiry equals issuedAt', async () => {
      const res = await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      for (const q of res.quotes) {
        expect(q.quote.expiry).to.equal(q.quote.issuedAt);
      }
    });

    it('submitter is QuotedCalls address', async () => {
      const res = await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      for (const q of res.quotes) {
        expect(q.quote.submitter).to.equal(QUOTED_CALLS);
      }
    });

    it('uses provided salt', async () => {
      const res = await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      for (const q of res.quotes) {
        expect(q.quote.salt).to.equal(SALT);
      }
    });

    it('ICA returns IGP only', async () => {
      const res = await service.getQuote(
        'ethereum',
        QuotedCallsCommand.CallRemoteWithOverrides,
        ROUTER,
        DESTINATION,
        SALT,
      );
      expect(res.quotes).to.have.lengthOf(1);
      expect(res.quotes[0].quoter.toLowerCase()).to.equal(
        IGP_ADDRESS.toLowerCase(),
      );
    });
  });

  describe('standing mode', () => {
    let service: QuoteService;
    beforeEach(() => {
      service = createTestService({ quoteMode: 'standing', quoteExpiry: 300 });
    });

    it('expiry > issuedAt', async () => {
      const res = await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      for (const q of res.quotes) {
        expect(q.quote.expiry).to.be.greaterThan(q.quote.issuedAt);
      }
    });

    it('submitter is address(0)', async () => {
      const res = await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      for (const q of res.quotes) {
        expect(q.quote.submitter).to.equal(ZERO_ADDRESS);
      }
    });

    it('uses provided salt', async () => {
      const res = await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      for (const q of res.quotes) {
        expect(q.quote.salt).to.equal(SALT);
      }
    });
  });

  describe('signature', () => {
    it('is valid EIP-712', async () => {
      const service = createTestService();
      const res = await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      const { quote, signature } = res.quotes[0];
      const valid = await verifyTypedData({
        address: TEST_ACCOUNT.address,
        domain: {
          ...EIP712_DOMAIN,
          chainId: 1n,
          verifyingContract: FEE_CONTRACT,
        },
        types: SIGNED_QUOTE_TYPES,
        primaryType: 'SignedQuote',
        message: {
          context: quote.context,
          data: quote.data,
          issuedAt: quote.issuedAt,
          expiry: quote.expiry,
          salt: quote.salt,
          submitter: quote.submitter,
        },
        signature,
      });
      expect(valid).to.be.true;
    });
  });

  describe('routing resolution', () => {
    const DEST_IGP = '0x7777777777777777777777777777777777777777' as Address;
    const FALLBACK_IGP =
      '0x8888888888888888888888888888888888888888' as Address;
    const DEST_FEE = '0x9999999999999999999999999999999999999999' as Address;

    function makeIgpConfig(address: Address) {
      return {
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        address,
        owner: ZERO_ADDRESS,
        beneficiary: ZERO_ADDRESS,
        oracleKey: ZERO_ADDRESS,
        overhead: {},
        oracleConfig: {},
        quoteSigners: [TEST_SIGNER],
      };
    }

    function svcWithHook(hook: any) {
      const routers = new Map();
      routers.set(ROUTER, {
        feeToken: FEE_TOKEN,
        derivedConfig: { ...mockDerivedConfig, hook },
      });
      const chainContexts = new Map<string, ChainQuoteContext>();
      chainContexts.set('ethereum', createTestContext({ routers }));
      return createTestService({ chainContexts });
    }

    it('resolves destination-specific IGP from routing hook', async () => {
      const svc = svcWithHook({
        type: HookType.ROUTING,
        address: '0x0000000000000000000000000000000000000001',
        owner: ZERO_ADDRESS,
        domains: { arbitrum: makeIgpConfig(DEST_IGP) },
      });
      const res = await svc.getQuote(
        'ethereum',
        QuotedCallsCommand.CallRemoteWithOverrides,
        ROUTER,
        DESTINATION,
        SALT,
      );
      expect(res.quotes[0].quoter.toLowerCase()).to.equal(
        DEST_IGP.toLowerCase(),
      );
    });

    it('uses fallback hook when destination not in domains', async () => {
      const svc = svcWithHook({
        type: HookType.FALLBACK_ROUTING,
        address: '0x0000000000000000000000000000000000000001',
        owner: ZERO_ADDRESS,
        domains: {},
        fallback: makeIgpConfig(FALLBACK_IGP),
      });
      const res = await svc.getQuote(
        'ethereum',
        QuotedCallsCommand.CallRemoteWithOverrides,
        ROUTER,
        DESTINATION,
        SALT,
      );
      expect(res.quotes[0].quoter.toLowerCase()).to.equal(
        FALLBACK_IGP.toLowerCase(),
      );
    });

    it('finds IGP inside aggregation hook', async () => {
      const svc = svcWithHook({
        type: HookType.AGGREGATION,
        address: '0x0000000000000000000000000000000000000001',
        hooks: [
          {
            type: HookType.MERKLE_TREE,
            address: '0x0000000000000000000000000000000000000002',
          },
          makeIgpConfig(DEST_IGP),
        ],
      });
      const res = await svc.getQuote(
        'ethereum',
        QuotedCallsCommand.CallRemoteWithOverrides,
        ROUTER,
        DESTINATION,
        SALT,
      );
      expect(res.quotes[0].quoter.toLowerCase()).to.equal(
        DEST_IGP.toLowerCase(),
      );
    });

    it('falls back to parent fee contract when destination not in feeContracts', async () => {
      const routers = new Map();
      routers.set(ROUTER, {
        feeToken: FEE_TOKEN,
        derivedConfig: {
          ...mockDerivedConfig,
          tokenFee: {
            type: TokenFeeType.RoutingFee,
            address: FEE_CONTRACT,
            token: FEE_TOKEN,
            owner: ZERO_ADDRESS,
            quoteSigners: [TEST_SIGNER],
            feeContracts: {
              optimism: {
                type: TokenFeeType.OffchainQuotedLinearFee,
                address: DEST_FEE,
                token: FEE_TOKEN,
                owner: ZERO_ADDRESS,
                maxFee: 0n,
                halfAmount: 1n,
                bps: 0n,
                quoteSigners: [TEST_SIGNER],
              },
            },
          },
        },
      });
      const chainContexts = new Map<string, ChainQuoteContext>();
      chainContexts.set('ethereum', createTestContext({ routers }));
      const svc = createTestService({ chainContexts });

      const res = await svc.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      const feeQuote = res.quotes.find(
        (q) => q.quoter.toLowerCase() === FEE_CONTRACT.toLowerCase(),
      );
      expect(feeQuote).to.exist;
    });
  });

  describe('signer authorization', () => {
    const OTHER_SIGNER =
      '0x5555555555555555555555555555555555555555' as Address;

    it('skips IGP quote when quoteSigners is empty (not upgraded)', async () => {
      const routers = new Map();
      routers.set(ROUTER, {
        feeToken: FEE_TOKEN,
        derivedConfig: {
          ...mockDerivedConfig,
          hook: { ...mockDerivedConfig.hook, quoteSigners: [] },
        },
      });
      const chainContexts = new Map<string, ChainQuoteContext>();
      chainContexts.set('ethereum', createTestContext({ routers }));
      const svc = createTestService({ chainContexts });

      const res = await svc.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      expect(res.quotes).to.have.lengthOf(1);
      expect(res.quotes[0].quoter.toLowerCase()).to.equal(
        FEE_CONTRACT.toLowerCase(),
      );
    });

    it('skips IGP quote when quoteSigners is undefined (not upgraded)', async () => {
      const routers = new Map();
      routers.set(ROUTER, {
        feeToken: FEE_TOKEN,
        derivedConfig: {
          ...mockDerivedConfig,
          hook: { ...mockDerivedConfig.hook, quoteSigners: undefined },
        },
      });
      const chainContexts = new Map<string, ChainQuoteContext>();
      chainContexts.set('ethereum', createTestContext({ routers }));
      const svc = createTestService({ chainContexts });

      const res = await svc.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      expect(res.quotes).to.have.lengthOf(1);
      expect(res.quotes[0].quoter.toLowerCase()).to.equal(
        FEE_CONTRACT.toLowerCase(),
      );
    });

    it('skips warp fee quote when signer not authorized', async () => {
      const routers = new Map();
      routers.set(ROUTER, {
        feeToken: FEE_TOKEN,
        derivedConfig: {
          ...mockDerivedConfig,
          tokenFee: {
            ...mockDerivedConfig.tokenFee,
            quoteSigners: [OTHER_SIGNER],
          },
        },
      });
      const chainContexts = new Map<string, ChainQuoteContext>();
      chainContexts.set('ethereum', createTestContext({ routers }));
      const svc = createTestService({ chainContexts });

      const res = await svc.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      expect(res.quotes).to.have.lengthOf(1);
      expect(res.quotes[0].quoter.toLowerCase()).to.equal(
        IGP_ADDRESS.toLowerCase(),
      );
    });

    it('skips IGP quote when signer not authorized', async () => {
      const routers = new Map();
      routers.set(ROUTER, {
        feeToken: FEE_TOKEN,
        derivedConfig: {
          ...mockDerivedConfig,
          hook: { ...mockDerivedConfig.hook, quoteSigners: [OTHER_SIGNER] },
        },
      });
      const chainContexts = new Map<string, ChainQuoteContext>();
      chainContexts.set('ethereum', createTestContext({ routers }));
      const svc = createTestService({ chainContexts });

      const res = await svc.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      expect(res.quotes).to.have.lengthOf(1);
      expect(res.quotes[0].quoter.toLowerCase()).to.equal(
        FEE_CONTRACT.toLowerCase(),
      );
    });

    it('returns empty quotes when not authorized on any quoter', async () => {
      const routers = new Map();
      routers.set(ROUTER, {
        feeToken: FEE_TOKEN,
        derivedConfig: {
          ...mockDerivedConfig,
          hook: { ...mockDerivedConfig.hook, quoteSigners: [OTHER_SIGNER] },
          tokenFee: {
            ...mockDerivedConfig.tokenFee,
            quoteSigners: [OTHER_SIGNER],
          },
        },
      });
      const chainContexts = new Map<string, ChainQuoteContext>();
      chainContexts.set('ethereum', createTestContext({ routers }));
      const svc = createTestService({ chainContexts });

      const res = await svc.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      expect(res.quotes).to.have.lengthOf(0);
    });
  });

  it('throws for unknown origin', async () => {
    const service = createTestService();
    try {
      await service.getQuote(
        'unknown',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('Unknown origin');
    }
  });

  it('throws for unknown router', async () => {
    const service = createTestService();
    try {
      await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        '0x9999999999999999999999999999999999999999' as Address,
        DESTINATION,
        SALT,
        RECIPIENT,
      );
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('Unknown router');
    }
  });

  it('throws without recipient for warp command', async () => {
    const service = createTestService();
    try {
      await service.getQuote(
        'ethereum',
        QuotedCallsCommand.TransferRemote,
        ROUTER,
        DESTINATION,
        SALT,
      );
      expect.fail('Should have thrown');
    } catch (e: any) {
      expect(e.message).to.include('recipient required');
    }
  });
});
