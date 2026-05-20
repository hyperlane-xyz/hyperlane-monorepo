import { expect } from 'chai';
import express, { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { type Address, type Hex, hexToBytes, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  type DerivedTokenRouterConfig,
  type EthereumQuoteV2Entry,
  HookType,
  NO_QUOTE_AVAILABLE_ERROR,
  NoQuoteAvailableReason,
  type SealevelQuoteV2Entry,
  TokenFeeType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  type FeeArtifactConfig,
  FeeParamsType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';

import {
  EIP712_DOMAIN,
  SIGNED_QUOTE_TYPES,
  ZERO_ADDRESS,
} from '../../src/constants.js';
import { createApiKeyAuth } from '../../src/middleware/apiKeyAuth.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { createQuoteV2Router } from '../../src/routes/quote.v2.js';
import { EvmQuoteService } from '../../src/services/evmQuoteService.js';
import { QuoteService } from '../../src/services/quoteService.js';
import { SvmQuoteService } from '../../src/services/svmQuoteService.js';

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
// EVM v2 requires `txSubmitter` but ignores the value (server's quoteMode
// drives the EIP-712 submitter). Any well-formed address works in tests.
const TX_SUBMITTER = '0xdddddddddddddddddddddddddddddddddddddddd';

const BASE_QUERY = `origin=ethereum&router=${ROUTER}&destination=${DEST_DOMAIN}&salt=${SALT}&txSubmitter=${TX_SUBMITTER}`;
const WARP_QUERY = `${BASE_QUERY}&recipient=${RECIPIENT}&targetRouter=${TARGET_ROUTER}`;

// ============ Sealevel fixtures ============

// Base58 placeholders — valid encodings so `@solana/kit`'s `address()` parser
// accepts them. Actual PDAs don't matter since `fromState` bypasses on-chain
// reads.
const SVM_WARP_PROGRAM = '11111bbn7XmLuiNnyUkAbvEMH74R6CnTXQgB2PLNqt';
const SVM_FEE_ACCOUNT_PDA = '11111111111111111111111111111114';
const SVM_IGP_ACCOUNT_PDA = '11111111111111111111111111111116';
const SVM_TX_SUBMITTER = '11111111111111111111111111111117';
const SVM_ORIGIN = 'solana';
const SVM_ORIGIN_DOMAIN = 1399811149;

const SVM_TEST_PRIVATE_KEY = hexToBytes(TEST_PRIVATE_KEY);
// EVM and SVM whitelists use the same H160 (secp256k1 → keccak → last 20),
// so the EVM signer address registered above is also the SVM signer ID.
const SVM_SIGNER_H160 = TEST_SIGNER;

const SVM_BASE_QUERY = `origin=${SVM_ORIGIN}&router=${SVM_WARP_PROGRAM}&destination=${DEST_DOMAIN}&salt=${SALT}&txSubmitter=${SVM_TX_SUBMITTER}`;
const SVM_WARP_QUERY = `${SVM_BASE_QUERY}&recipient=${RECIPIENT}&targetRouter=${TARGET_ROUTER}`;

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

  const logger = pino({ level: 'silent' });
  const evm = EvmQuoteService.fromState({
    signerKey: TEST_PRIVATE_KEY,
    logger,
    routes: [
      {
        origin: 'ethereum',
        warpRouter: ROUTER,
        chainId: 1,
        quotedCallsAddress: QUOTED_CALLS,
        feeToken: FEE_TOKEN,
        derivedConfig: derivedConfig as unknown as DerivedTokenRouterConfig,
      },
    ],
  });

  const quoteService = new QuoteService({
    evm,
    services: new Map([[ProtocolType.Ethereum, evm]]),
    protocolByChain: new Map([['ethereum', ProtocolType.Ethereum]]),
    quoteMode: 'transient',
    quoteExpiry: 300,
    multiProvider: {
      getChainName: (d: number) =>
        d === DEST_DOMAIN ? DEST_CHAIN_NAME : `chain-${d}`,
      getChainId: () => 1,
    } as any,
    logger,
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

// ============ Sealevel test app builder ============

interface SvmContextOverrides {
  warpQuoteSigners?: string[];
  igpSigners?: string[];
  hasFee?: boolean;
  hasIgp?: boolean;
}

function svmOffchainQuotedLeaf(signers: string[]): FeeArtifactConfig {
  return {
    type: FeeType.offchainQuotedLinear,
    owner: SVM_SIGNER_H160,
    beneficiary: SVM_SIGNER_H160,
    params: { type: FeeParamsType.raw, maxFee: '0', halfAmount: '1' },
    quoteSigners: signers,
  };
}

function createSvmTestApp(opts: SvmContextOverrides = {}): Express {
  const {
    warpQuoteSigners = [SVM_SIGNER_H160],
    igpSigners = [SVM_SIGNER_H160],
    hasFee = true,
    hasIgp = true,
  } = opts;

  const logger = pino({ level: 'silent' });
  // EVM service is still required by `QuoteService` for the v1 handle, but
  // protocolByChain has no Ethereum entry so v2 traffic never reaches it.
  const evm = EvmQuoteService.fromState({
    signerKey: TEST_PRIVATE_KEY,
    logger,
    routes: [],
  });
  const svm = SvmQuoteService.fromState({
    signerKey: SVM_TEST_PRIVATE_KEY,
    logger,
    routes: [
      {
        origin: SVM_ORIGIN,
        domainId: SVM_ORIGIN_DOMAIN,
        warpProgramId: SVM_WARP_PROGRAM,
        fee: hasFee
          ? {
              feeAccountPda: SVM_FEE_ACCOUNT_PDA,
              config: svmOffchainQuotedLeaf(warpQuoteSigners),
            }
          : undefined,
        igp: hasIgp
          ? { igpAccountPda: SVM_IGP_ACCOUNT_PDA, signers: igpSigners }
          : undefined,
      },
    ],
  });

  const quoteService = new QuoteService({
    evm,
    services: new Map([
      [ProtocolType.Ethereum, evm],
      [ProtocolType.Sealevel, svm],
    ]),
    protocolByChain: new Map([[SVM_ORIGIN, ProtocolType.Sealevel]]),
    quoteMode: 'transient',
    quoteExpiry: 300,
    multiProvider: {
      getChainName: (d: number) =>
        d === DEST_DOMAIN ? DEST_CHAIN_NAME : `chain-${d}`,
      getChainId: () => 1,
    } as any,
    logger,
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
        name: 'igp: router fails ZHash format check',
        path: `/v2/quote/igp?origin=ethereum&router=0xnotanaddress&destination=${DEST_DOMAIN}&salt=${SALT}&txSubmitter=${TX_SUBMITTER}`,
      },
      {
        name: 'warp: unknown origin',
        path: `/v2/quote/warp?origin=unknown&router=${ROUTER}&destination=${DEST_DOMAIN}&salt=${SALT}&recipient=${RECIPIENT}&targetRouter=${TARGET_ROUTER}&txSubmitter=${TX_SUBMITTER}`,
        includesMessage: 'Unknown origin',
      },
      {
        name: 'igp: unknown router',
        path: `/v2/quote/igp?origin=ethereum&router=0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead&destination=${DEST_DOMAIN}&salt=${SALT}&txSubmitter=${TX_SUBMITTER}`,
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

  // ============ Sealevel ============

  describe('Sealevel happy paths — SealevelQuoteV2Entry shape', () => {
    interface SvmHappyCase {
      name: string;
      path: string;
      quoter: string;
      // Hex length includes '0x' + 2 chars per byte.
      contextHexLen: number;
      dataHexLen: number;
    }
    const cases: SvmHappyCase[] = [
      {
        name: 'warp: 44B Leaf context + 17B Linear data',
        path: `/v2/quote/warp?${SVM_WARP_QUERY}`,
        quoter: SVM_FEE_ACCOUNT_PDA,
        contextHexLen: 2 + 44 * 2,
        dataHexLen: 2 + 17 * 2,
      },
      {
        name: 'igp: 68B context + 33B (u128, u128, u8) data',
        path: `/v2/quote/igp?${SVM_BASE_QUERY}`,
        quoter: SVM_IGP_ACCOUNT_PDA,
        contextHexLen: 2 + 68 * 2,
        dataHexLen: 2 + 33 * 2,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const app = createSvmTestApp();
        const res = await authed(app, c.path).expect(200);
        const entry = res.body.quote as SealevelQuoteV2Entry;
        expect(entry.protocol).to.equal(ProtocolType.Sealevel);
        expect(entry.quoter).to.equal(c.quoter);
        expect(entry.details.domainId).to.equal(SVM_ORIGIN_DOMAIN);
        expect(entry.details.signedQuote.context).to.have.lengthOf(
          c.contextHexLen,
        );
        expect(entry.details.signedQuote.data).to.have.lengthOf(c.dataHexLen);
        expect(entry.details.signedQuote.signature).to.have.lengthOf(
          2 + 65 * 2,
        );
        expect(entry.details.signedQuote.clientSalt).to.have.lengthOf(
          2 + 32 * 2,
        );
      });
    }
  });

  describe('Sealevel 404 skip paths', () => {
    interface SkipCase {
      name: string;
      path: string;
      overrides: SvmContextOverrides;
      reason: NoQuoteAvailableReason;
    }
    const cases: SkipCase[] = [
      {
        name: 'warp: not_authorized when signer is not on the whitelist',
        path: `/v2/quote/warp?${SVM_WARP_QUERY}`,
        overrides: { warpQuoteSigners: [OTHER_SIGNER] },
        reason: NoQuoteAvailableReason.NotAuthorized,
      },
      {
        name: 'warp: not_upgraded when quoteSigners is empty',
        path: `/v2/quote/warp?${SVM_WARP_QUERY}`,
        overrides: { warpQuoteSigners: [] },
        reason: NoQuoteAvailableReason.NotUpgraded,
      },
      {
        name: 'warp: not_configured when route has no fee',
        path: `/v2/quote/warp?${SVM_WARP_QUERY}`,
        overrides: { hasFee: false },
        reason: NoQuoteAvailableReason.NotConfigured,
      },
      {
        name: 'igp: not_authorized when signer is not on the whitelist',
        path: `/v2/quote/igp?${SVM_BASE_QUERY}`,
        overrides: { igpSigners: [OTHER_SIGNER] },
        reason: NoQuoteAvailableReason.NotAuthorized,
      },
      {
        name: 'igp: not_upgraded when IGP signers are empty',
        path: `/v2/quote/igp?${SVM_BASE_QUERY}`,
        overrides: { igpSigners: [] },
        reason: NoQuoteAvailableReason.NotUpgraded,
      },
      {
        name: 'igp: not_configured when route has no IGP',
        path: `/v2/quote/igp?${SVM_BASE_QUERY}`,
        overrides: { hasIgp: false },
        reason: NoQuoteAvailableReason.NotConfigured,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const app = createSvmTestApp(c.overrides);
        const res = await authed(app, c.path).expect(404);
        expect(res.body.error).to.equal(NO_QUOTE_AVAILABLE_ERROR);
        expect(res.body.reason).to.equal(c.reason);
      });
    }
  });
});
