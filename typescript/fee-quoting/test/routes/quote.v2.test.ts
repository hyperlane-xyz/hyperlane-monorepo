import { expect } from 'chai';
import express, { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { type Address, type Hex, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  type EthereumQuoteV2Entry,
  HookType,
  NO_QUOTE_AVAILABLE_ERROR,
  NoQuoteAvailableReason,
  TokenFeeType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  EIP712_DOMAIN,
  SIGNED_QUOTE_TYPES,
  ZERO_ADDRESS,
} from '../../src/constants.js';
import { createApiKeyAuth } from '../../src/middleware/apiKeyAuth.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { createQuoteV2Router } from '../../src/routes/quote.v2.js';
import {
  QuoteService,
  type ChainQuoteContext,
  type EvmRouterQuoteContext,
} from '../../src/services/quoteService.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
const TEST_SIGNER = TEST_ACCOUNT.address;
const OTHER_SIGNER = '0x5555555555555555555555555555555555555555' as Address;
const TEST_API_KEY = 'test-api-key-123';

const FEE_CONTRACT = '0x1111111111111111111111111111111111111111' as Address;
const IGP_ADDRESS = '0x2222222222222222222222222222222222222222' as Address;
const FEE_TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const QUOTED_CALLS = '0x4444444444444444444444444444444444444444' as Address;
const ROUTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const RECIPIENT =
  '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const TARGET_ROUTER =
  '0x000000000000000000000000cccccccccccccccccccccccccccccccccccccccc' as Hex;
const SALT =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;
const DEST_DOMAIN = 42161;
const DEST_CHAIN_NAME = 'arbitrum';

const BASE_QUERY = `origin=ethereum&router=${ROUTER}&destination=${DEST_DOMAIN}&salt=${SALT}`;
const WARP_QUERY = `${BASE_QUERY}&recipient=${RECIPIENT}&targetRouter=${TARGET_ROUTER}`;

interface ContextOverrides {
  warpQuoteSigners?: string[];
  igpQuoteSigners?: string[];
  hasTokenFee?: boolean;
  hasHookIgp?: boolean;
}

function createTestApp(opts: ContextOverrides = {}): Express {
  const {
    warpQuoteSigners = [TEST_SIGNER],
    igpQuoteSigners = [TEST_SIGNER],
    hasTokenFee = true,
    hasHookIgp = true,
  } = opts;

  const derivedConfig = {
    hook: hasHookIgp
      ? {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          address: IGP_ADDRESS,
          owner: ZERO_ADDRESS,
          beneficiary: ZERO_ADDRESS,
          oracleKey: ZERO_ADDRESS,
          overhead: {},
          oracleConfig: {},
          quoteSigners: igpQuoteSigners,
        }
      : ZERO_ADDRESS,
    tokenFee: hasTokenFee
      ? {
          type: TokenFeeType.OffchainQuotedLinearFee,
          address: FEE_CONTRACT,
          token: FEE_TOKEN,
          owner: ZERO_ADDRESS,
          maxFee: 0n,
          halfAmount: 1n,
          bps: 0n,
          quoteSigners: warpQuoteSigners,
        }
      : undefined,
  };

  const routerCtx: EvmRouterQuoteContext = {
    protocol: ProtocolType.Ethereum,
    chainId: 1,
    quotedCallsAddress: QUOTED_CALLS,
    feeToken: FEE_TOKEN,
    derivedConfig: derivedConfig as any,
  };
  const routers = new Map<string, EvmRouterQuoteContext>();
  routers.set(ROUTER.toLowerCase(), routerCtx);

  const chainContexts = new Map<string, ChainQuoteContext>();
  chainContexts.set('ethereum', {
    protocol: ProtocolType.Ethereum,
    chainName: 'ethereum',
    quotedCallsAddress: QUOTED_CALLS,
    routers,
  });

  const quoteService = new QuoteService({
    signerKey: TEST_PRIVATE_KEY,
    quoteMode: 'transient',
    quoteExpiry: 300,
    multiProvider: {
      getChainName: (d: number) =>
        d === DEST_DOMAIN ? DEST_CHAIN_NAME : `chain-${d}`,
      getChainId: () => 1,
    } as any,
    chainContexts,
    logger: pino({ level: 'silent' }),
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/v2/quote',
    createApiKeyAuth(new Set([TEST_API_KEY]), pino({ level: 'silent' })),
    createQuoteV2Router(quoteService),
  );
  app.use(createErrorHandler(pino({ level: 'silent' })));
  return app;
}

function authed(app: Express, path: string) {
  return request(app).get(path).set('Authorization', `Bearer ${TEST_API_KEY}`);
}

describe('v2 Quote Routes', () => {
  describe('auth', () => {
    const endpoints = [
      { name: '/v2/quote/warp', path: `/v2/quote/warp?${WARP_QUERY}` },
      { name: '/v2/quote/igp', path: `/v2/quote/igp?${BASE_QUERY}` },
    ];
    for (const { name, path } of endpoints) {
      it(`returns 401 without API key on ${name}`, async () => {
        const app = createTestApp();
        await request(app).get(path).expect(401);
      });
    }
  });

  describe('happy paths — EVM EIP-712 verification', () => {
    const cases = [
      {
        name: 'warp',
        path: `/v2/quote/warp?${WARP_QUERY}`,
        verifyingContract: FEE_CONTRACT,
      },
      {
        name: 'igp',
        path: `/v2/quote/igp?${BASE_QUERY}`,
        verifyingContract: IGP_ADDRESS,
      },
    ];

    for (const c of cases) {
      it(`${c.name}: returns a quote signed by the configured key`, async () => {
        const app = createTestApp();
        const res = await authed(app, c.path).expect(200);

        const entry = res.body.quote as EthereumQuoteV2Entry;
        expect(entry.protocol).to.equal(ProtocolType.Ethereum);
        expect(entry.quoter.toLowerCase()).to.equal(
          c.verifyingContract.toLowerCase(),
        );

        const recovered = await verifyTypedData({
          address: TEST_SIGNER,
          domain: {
            ...EIP712_DOMAIN,
            chainId: 1,
            verifyingContract: c.verifyingContract,
          },
          types: SIGNED_QUOTE_TYPES,
          primaryType: 'SignedQuote',
          message: entry.details.quote,
          signature: entry.details.signature,
        });
        expect(recovered).to.be.true;
      });
    }
  });

  describe('404 skip paths', () => {
    interface SkipCase {
      name: string;
      path: string;
      overrides: ContextOverrides;
      reason: NoQuoteAvailableReason;
    }
    const cases: SkipCase[] = [
      {
        name: 'warp: not_authorized when our signer is not on the whitelist',
        path: `/v2/quote/warp?${WARP_QUERY}`,
        overrides: { warpQuoteSigners: [OTHER_SIGNER] },
        reason: NoQuoteAvailableReason.NotAuthorized,
      },
      {
        name: 'warp: not_upgraded when quoteSigners is empty',
        path: `/v2/quote/warp?${WARP_QUERY}`,
        overrides: { warpQuoteSigners: [] },
        reason: NoQuoteAvailableReason.NotUpgraded,
      },
      {
        name: 'warp: not_configured when tokenFee is absent',
        path: `/v2/quote/warp?${WARP_QUERY}`,
        overrides: { hasTokenFee: false },
        reason: NoQuoteAvailableReason.NotConfigured,
      },
      {
        name: 'igp: not_authorized when our signer is not on the whitelist',
        path: `/v2/quote/igp?${BASE_QUERY}`,
        overrides: { igpQuoteSigners: [OTHER_SIGNER] },
        reason: NoQuoteAvailableReason.NotAuthorized,
      },
      {
        name: 'igp: not_upgraded when quoteSigners is empty',
        path: `/v2/quote/igp?${BASE_QUERY}`,
        overrides: { igpQuoteSigners: [] },
        reason: NoQuoteAvailableReason.NotUpgraded,
      },
      {
        name: 'igp: not_configured when no IGP hook present',
        path: `/v2/quote/igp?${BASE_QUERY}`,
        overrides: { hasHookIgp: false },
        reason: NoQuoteAvailableReason.NotConfigured,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const app = createTestApp(c.overrides);
        const res = await authed(app, c.path).expect(404);
        expect(res.body.error).to.equal(NO_QUOTE_AVAILABLE_ERROR);
        expect(res.body.reason).to.equal(c.reason);
        expect(res.body.detail).to.be.a('string').and.to.have.length.above(0);
      });
    }
  });

  describe('400 validation errors', () => {
    interface ValidationCase {
      name: string;
      path: string;
      includesMessage?: string;
    }
    const cases: ValidationCase[] = [
      {
        name: 'warp: missing targetRouter',
        path: `/v2/quote/warp?${BASE_QUERY}&recipient=${RECIPIENT}`,
      },
      {
        name: 'warp: missing recipient',
        path: `/v2/quote/warp?${BASE_QUERY}&targetRouter=${TARGET_ROUTER}`,
      },
      {
        name: 'warp: recipient is not bytes32 hex',
        path: `/v2/quote/warp?${BASE_QUERY}&recipient=0xabc&targetRouter=${TARGET_ROUTER}`,
      },
      {
        name: 'igp: router is not a valid EVM address',
        path: `/v2/quote/igp?origin=ethereum&router=0xnotanaddress&destination=${DEST_DOMAIN}&salt=${SALT}`,
      },
      {
        name: 'warp: unknown origin',
        path: `/v2/quote/warp?origin=unknown&router=${ROUTER}&destination=${DEST_DOMAIN}&salt=${SALT}&recipient=${RECIPIENT}&targetRouter=${TARGET_ROUTER}`,
        includesMessage: 'Unknown origin',
      },
      {
        name: 'igp: unknown router',
        path: `/v2/quote/igp?origin=ethereum&router=0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead&destination=${DEST_DOMAIN}&salt=${SALT}`,
        includesMessage: 'Unknown router',
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const app = createTestApp();
        const res = await authed(app, c.path).expect(400);
        if (c.includesMessage) {
          expect(res.body.message).to.include(c.includesMessage);
        }
      });
    }
  });
});
