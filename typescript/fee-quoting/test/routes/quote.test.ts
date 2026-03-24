import { expect } from 'chai';
import express, { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import type { Address, Hex } from 'viem';

import { HookType } from '@hyperlane-xyz/sdk';
import { TokenFeeType } from '@hyperlane-xyz/sdk';

import { ZERO_ADDRESS } from '../../src/constants.js';
import { createApiKeyAuth } from '../../src/middleware/apiKeyAuth.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { createQuoteRouter } from '../../src/routes/quote.js';
import {
  QuoteService,
  type ChainQuoteContext,
} from '../../src/services/quoteService.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const TEST_API_KEY = 'test-api-key-123';

const FEE_CONTRACT = '0x1111111111111111111111111111111111111111' as Address;
const IGP_ADDRESS = '0x2222222222222222222222222222222222222222' as Address;
const FEE_TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const QUOTED_CALLS = '0x4444444444444444444444444444444444444444' as Address;
const ROUTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RECIPIENT =
  '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SALT =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const WARP_PARAMS = `origin=ethereum&router=${ROUTER}&destination=42161&salt=${SALT}&recipient=${RECIPIENT}`;
const ICA_PARAMS = `origin=ethereum&router=${ROUTER}&destination=42161&salt=${SALT}`;

function createTestApp(): Express {
  const routers = new Map();
  routers.set(ROUTER as Address, {
    feeToken: FEE_TOKEN,
    derivedConfig: {
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
    } as any,
  });

  const chainContexts = new Map<string, ChainQuoteContext>();
  chainContexts.set('ethereum', {
    chainId: 1,
    domainId: 1,
    chainName: 'ethereum',
    quotedCallsAddress: QUOTED_CALLS,
    multiProvider: {
      getChainName: (d: number) => (d === 42161 ? 'arbitrum' : `chain-${d}`),
    } as any,
    routers,
  });

  const quoteService = new QuoteService({
    signerKey: TEST_PRIVATE_KEY,
    quoteMode: 'transient',
    quoteExpiry: 300,
    chainContexts,
    logger: pino({ level: 'silent' }),
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/quote',
    createApiKeyAuth(new Set([TEST_API_KEY]), pino({ level: 'silent' })),
    createQuoteRouter(quoteService),
  );
  app.use(createErrorHandler(pino({ level: 'silent' })));
  return app;
}

describe('Quote Routes', () => {
  let app: Express;
  beforeEach(() => {
    app = createTestApp();
  });

  it('returns 401 without API key', async () => {
    await request(app).get(`/quote/transferRemote?${WARP_PARAMS}`).expect(401);
  });

  describe('GET /quote/transferRemote', () => {
    it('returns warp fee + IGP quotes', async () => {
      const res = await request(app)
        .get(`/quote/transferRemote?${WARP_PARAMS}`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);
      expect(res.body.quotes).to.be.an('array').with.lengthOf(2);
    });

    it('returns 400 without salt', async () => {
      const params = `origin=ethereum&router=${ROUTER}&destination=42161&recipient=${RECIPIENT}`;
      await request(app)
        .get(`/quote/transferRemote?${params}`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(400);
    });

    it('returns 400 for unknown origin', async () => {
      const params = `origin=unknown&router=${ROUTER}&destination=42161&salt=${SALT}&recipient=${RECIPIENT}`;
      const res = await request(app)
        .get(`/quote/transferRemote?${params}`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(400);
      expect(res.body.message).to.include('Unknown origin');
    });
  });

  describe('GET /quote/callRemoteWithOverrides', () => {
    it('returns IGP quote only', async () => {
      const res = await request(app)
        .get(`/quote/callRemoteWithOverrides?${ICA_PARAMS}`)
        .set('Authorization', `Bearer ${TEST_API_KEY}`)
        .expect(200);
      expect(res.body.quotes).to.have.lengthOf(1);
      expect(res.body.quotes[0].quoter.toLowerCase()).to.equal(
        IGP_ADDRESS.toLowerCase(),
      );
    });
  });
});
