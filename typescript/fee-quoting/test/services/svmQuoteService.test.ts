import { expect } from 'chai';
import { pino } from 'pino';
import { type Hex, hexToBytes } from 'viem';

import {
  type FeeArtifactConfig,
  FeeParamsType,
  FeeStrategyType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import {
  DEFAULT_ROUTER_KEY,
  NoQuoteAvailableReason,
  type SealevelQuoteV2Entry,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ethAddressHexFromPrivateKey } from '@hyperlane-xyz/sealevel-sdk';

import { QuoteMode } from '../../src/config.js';
import {
  ApiError,
  NoQuoteAvailableError,
} from '../../src/middleware/errorHandler.js';
import type { QuoteBinding } from '../../src/services/IProtocolQuoteService.js';
import {
  SvmQuoteService,
  type SvmRouteState,
} from '../../src/services/svmQuoteService.js';

// Foundry/Hardhat default test account #0 — same key the EVM tests use so the
// H160 recovered from the SVM signature equals the EVM signer address.
const TEST_PRIVATE_KEY_HEX =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_PRIVATE_KEY = hexToBytes(TEST_PRIVATE_KEY_HEX);
const TEST_SIGNER_H160 = ethAddressHexFromPrivateKey(TEST_PRIVATE_KEY);
const OTHER_SIGNER = '0x5555555555555555555555555555555555555555';

// Base58 placeholders — chosen as valid base58 so `@solana/kit`'s `address()`
// parser accepts them. Actual PDAs / program IDs are irrelevant here since we
// bypass on-chain reads via `fromState`.
const WARP_PROGRAM_ID = '11111111111111111111111111111112';
const FEE_ACCOUNT_PDA = '11111111111111111111111111111114';
const IGP_ACCOUNT_PDA = '11111111111111111111111111111116';
const TX_SUBMITTER = '11111111111111111111111111111117';

const ORIGIN = 'solana';
const ORIGIN_DOMAIN = 1399811149;
const DEST_DOMAIN = 42161;
const DEST_CHAIN_NAME = 'arbitrum';
const RECIPIENT =
  '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const TARGET_ROUTER =
  '0x000000000000000000000000cccccccccccccccccccccccccccccccccccccccc' as Hex;
const SALT =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;

const TRANSIENT_BINDING: QuoteBinding = {
  kind: QuoteMode.TRANSIENT,
  salt: SALT,
  transientBuffer: 60,
};

const STANDING_BINDING: QuoteBinding = {
  kind: QuoteMode.STANDING,
  salt: SALT,
  ttlSeconds: 300,
};

const HEX_LEAF_CONTEXT_LEN = 2 + 44 * 2;
const HEX_CC_CONTEXT_LEN = 2 + 76 * 2;
const HEX_IGP_CONTEXT_LEN = 2 + 68 * 2;
const HEX_IGP_DATA_LEN = 2 + 33 * 2;
const HEX_SIG_LEN = 2 + 65 * 2;
const HEX_SALT_LEN = 2 + 32 * 2;
const HEX_U48_LEN = 2 + 6 * 2;

function rawParams(maxFee: string, halfAmount: string) {
  return { type: FeeParamsType.raw, maxFee, halfAmount } as const;
}

function offchainQuotedLeaf(signers: string[]): FeeArtifactConfig {
  return {
    type: FeeType.offchainQuotedLinear,
    owner: TEST_SIGNER_H160,
    beneficiary: TEST_SIGNER_H160,
    params: rawParams('0', '1'),
    quoteSigners: signers,
  };
}

function linearLeaf(): FeeArtifactConfig {
  return {
    type: FeeType.linear,
    owner: TEST_SIGNER_H160,
    beneficiary: TEST_SIGNER_H160,
    params: rawParams('0', '1'),
  };
}

function routingFee(signers: string[]): FeeArtifactConfig {
  return {
    type: FeeType.routing,
    owner: TEST_SIGNER_H160,
    beneficiary: TEST_SIGNER_H160,
    routes: {
      [DEST_DOMAIN]: {
        type: FeeStrategyType.offchainQuotedLinear,
        params: rawParams('0', '1'),
        quoteSigners: signers,
      },
    },
  };
}

function ccRoutingFee(
  signers: string[],
  routerKey: string = TARGET_ROUTER,
): FeeArtifactConfig {
  return {
    type: FeeType.crossCollateralRouting,
    owner: TEST_SIGNER_H160,
    beneficiary: TEST_SIGNER_H160,
    routes: {
      [DEST_DOMAIN]: {
        [routerKey]: {
          type: FeeStrategyType.offchainQuotedLinear,
          params: rawParams('0', '1'),
          quoteSigners: signers,
        },
      },
    },
  };
}

interface RouteOpts {
  feeConfig?: FeeArtifactConfig;
  hasFee?: boolean;
  igpSigners?: string[];
  hasIgp?: boolean;
}

function createTestService(opts: RouteOpts = {}): SvmQuoteService {
  const {
    feeConfig = offchainQuotedLeaf([TEST_SIGNER_H160]),
    hasFee = true,
    igpSigners = [TEST_SIGNER_H160],
    hasIgp = true,
  } = opts;

  const route: { origin: string } & SvmRouteState = {
    origin: ORIGIN,
    domainId: ORIGIN_DOMAIN,
    warpProgramId: WARP_PROGRAM_ID,
    fee: hasFee
      ? { feeAccountPda: FEE_ACCOUNT_PDA, config: feeConfig }
      : undefined,
    igp: hasIgp
      ? { igpAccountPda: IGP_ACCOUNT_PDA, signers: igpSigners }
      : undefined,
  };

  return SvmQuoteService.fromState({
    signerKey: TEST_PRIVATE_KEY,
    logger: pino({ level: 'silent' }),
    routes: [route],
  });
}

const baseWarpReq = {
  origin: ORIGIN,
  router: WARP_PROGRAM_ID,
  destChainName: DEST_CHAIN_NAME,
  destination: DEST_DOMAIN,
  recipient: RECIPIENT,
  targetRouter: TARGET_ROUTER,
  txSubmitter: TX_SUBMITTER,
};

const baseIgpReq = {
  origin: ORIGIN,
  router: WARP_PROGRAM_ID,
  destChainName: DEST_CHAIN_NAME,
  destination: DEST_DOMAIN,
  sender: WARP_PROGRAM_ID,
  txSubmitter: TX_SUBMITTER,
};

function assertSealevelEntry(entry: SealevelQuoteV2Entry, quoter: string) {
  expect(entry.protocol).to.equal(ProtocolType.Sealevel);
  expect(entry.quoter).to.equal(quoter);
  expect(entry.details.domainId).to.equal(ORIGIN_DOMAIN);
  expect(entry.details.signedQuote.signature).to.have.lengthOf(HEX_SIG_LEN);
  expect(entry.details.signedQuote.clientSalt).to.have.lengthOf(HEX_SALT_LEN);
  expect(entry.details.signedQuote.issuedAt).to.have.lengthOf(HEX_U48_LEN);
  expect(entry.details.signedQuote.expiry).to.have.lengthOf(HEX_U48_LEN);
}

async function expectNoQuoteReason(
  promise: Promise<unknown>,
  reason: NoQuoteAvailableReason,
) {
  try {
    await promise;
    expect.fail(`expected NoQuoteAvailableError with reason ${reason}`);
  } catch (err) {
    if (!(err instanceof NoQuoteAvailableError)) throw err;
    expect(err.reason).to.equal(reason);
  }
}

describe('SvmQuoteService', () => {
  describe('getWarpQuote — fee-tree walking', () => {
    interface WalkCase {
      name: string;
      feeConfig: FeeArtifactConfig;
      binding?: QuoteBinding;
      expectedContextLen: number;
      /** Expected trailing 32B of the signed context, or undefined for non-CC. */
      expectedTrailingTargetRouter?: Hex;
    }
    const cases: WalkCase[] = [
      {
        name: 'top-level OffchainQuotedLinear → 44B Leaf context',
        feeConfig: offchainQuotedLeaf([TEST_SIGNER_H160]),
        expectedContextLen: HEX_LEAF_CONTEXT_LEN,
      },
      {
        name: 'RoutingFee.routes[dest] → 44B Leaf context',
        feeConfig: routingFee([TEST_SIGNER_H160]),
        expectedContextLen: HEX_LEAF_CONTEXT_LEN,
      },
      {
        name: 'CC routing with exact target router → 76B CC context with request target',
        feeConfig: ccRoutingFee([TEST_SIGNER_H160], TARGET_ROUTER),
        expectedContextLen: HEX_CC_CONTEXT_LEN,
        expectedTrailingTargetRouter: TARGET_ROUTER,
      },
      {
        name: 'CC routing with only DEFAULT fallback + standing binding → signs with DEFAULT_ROUTER',
        feeConfig: ccRoutingFee([TEST_SIGNER_H160], DEFAULT_ROUTER_KEY),
        binding: STANDING_BINDING,
        expectedContextLen: HEX_CC_CONTEXT_LEN,
        expectedTrailingTargetRouter: DEFAULT_ROUTER_KEY,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const svc = createTestService({ feeConfig: c.feeConfig });
        const entry = await svc.getWarpQuote({
          ...baseWarpReq,
          binding: c.binding ?? TRANSIENT_BINDING,
        });
        assertSealevelEntry(entry, FEE_ACCOUNT_PDA);
        expect(entry.details.signedQuote.context).to.have.lengthOf(
          c.expectedContextLen,
        );
        if (c.expectedTrailingTargetRouter) {
          const ctxHex = entry.details.signedQuote.context;
          const trailing = '0x' + ctxHex.slice(ctxHex.length - 64);
          expect(trailing.toLowerCase()).to.equal(
            c.expectedTrailingTargetRouter.toLowerCase(),
          );
        }
      });
    }
  });

  describe('getWarpQuote — timestamp binding', () => {
    interface BindingCase {
      name: string;
      binding: QuoteBinding;
      expectExpiryEqualsIssuedAt: boolean;
      expectTtl?: number;
    }
    const cases: BindingCase[] = [
      {
        name: 'transient: expiry equals issuedAt',
        binding: TRANSIENT_BINDING,
        expectExpiryEqualsIssuedAt: true,
      },
      {
        name: 'standing: expiry = issuedAt + ttlSeconds',
        binding: STANDING_BINDING,
        expectExpiryEqualsIssuedAt: false,
        expectTtl: STANDING_BINDING.ttlSeconds,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const svc = createTestService();
        const entry = await svc.getWarpQuote({
          ...baseWarpReq,
          binding: c.binding,
        });
        if (c.expectExpiryEqualsIssuedAt) {
          expect(entry.expiry).to.equal(entry.issuedAt);
        } else {
          expect(entry.expiry - entry.issuedAt).to.equal(c.expectTtl);
        }
      });
    }
  });

  describe('getWarpQuote — recipient substitution', () => {
    // 44B Leaf context layout: 4B dest_domain LE | 32B recipient | 8B amount LE.
    // Recipient occupies hex offset (0x + 8) .. (0x + 8 + 64).
    const HEX_PREFIX_LEN = 2;
    const HEX_DOMAIN_LEN = 4 * 2;
    const RECIPIENT_HEX_START = HEX_PREFIX_LEN + HEX_DOMAIN_LEN;
    const RECIPIENT_HEX_END = RECIPIENT_HEX_START + 32 * 2;
    const WILDCARD_RECIPIENT_HEX = '0x' + 'ff'.repeat(32);

    it('standing mode substitutes recipient with WILDCARD_RECIPIENT', async () => {
      const svc = createTestService();
      const entry = await svc.getWarpQuote({
        ...baseWarpReq,
        binding: STANDING_BINDING,
      });
      const ctx = entry.details.signedQuote.context;
      const signedRecipient =
        '0x' + ctx.slice(RECIPIENT_HEX_START, RECIPIENT_HEX_END);
      expect(signedRecipient.toLowerCase()).to.equal(WILDCARD_RECIPIENT_HEX);
      // Sanity: original user recipient was NOT what got signed.
      expect(signedRecipient.toLowerCase()).to.not.equal(
        RECIPIENT.toLowerCase(),
      );
    });

    it('transient mode preserves the user-supplied recipient', async () => {
      const svc = createTestService();
      const entry = await svc.getWarpQuote({
        ...baseWarpReq,
        binding: TRANSIENT_BINDING,
      });
      const ctx = entry.details.signedQuote.context;
      const signedRecipient =
        '0x' + ctx.slice(RECIPIENT_HEX_START, RECIPIENT_HEX_END);
      expect(signedRecipient.toLowerCase()).to.equal(RECIPIENT.toLowerCase());
    });
  });

  describe('getWarpQuote — txSubmitter validation', () => {
    it('rejects an EVM-shaped txSubmitter with a 400', async () => {
      const svc = createTestService();
      try {
        await svc.getWarpQuote({
          ...baseWarpReq,
          txSubmitter: '0x1111111111111111111111111111111111111111',
          binding: TRANSIENT_BINDING,
        });
        expect.fail('expected an ApiError');
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        expect(err.statusCode).to.equal(400);
        expect(err.message).to.match(/not a valid Sealevel address/);
      }
    });
  });

  describe('getWarpQuote — 404 skip paths', () => {
    interface SkipCase {
      name: string;
      opts: RouteOpts;
      reason: NoQuoteAvailableReason;
    }
    const cases: SkipCase[] = [
      {
        name: 'not_configured when no fee on route',
        opts: { hasFee: false },
        reason: NoQuoteAvailableReason.NotConfigured,
      },
      {
        name: 'not_configured when Routing has no entry for destination',
        opts: {
          feeConfig: {
            type: FeeType.routing,
            owner: TEST_SIGNER_H160,
            beneficiary: TEST_SIGNER_H160,
            routes: {},
          },
        },
        reason: NoQuoteAvailableReason.NotConfigured,
      },
      {
        name: 'not_configured when CC has neither specific target nor default',
        opts: {
          feeConfig: {
            type: FeeType.crossCollateralRouting,
            owner: TEST_SIGNER_H160,
            beneficiary: TEST_SIGNER_H160,
            routes: { [DEST_DOMAIN]: {} },
          },
        },
        reason: NoQuoteAvailableReason.NotConfigured,
      },
      {
        name: 'not_configured when CC only has DEFAULT fallback but binding is transient',
        opts: {
          feeConfig: ccRoutingFee([TEST_SIGNER_H160], DEFAULT_ROUTER_KEY),
        },
        reason: NoQuoteAvailableReason.NotConfigured,
      },
      {
        name: 'not_upgraded when leaf is Linear (not OffchainQuoted)',
        opts: { feeConfig: linearLeaf() },
        reason: NoQuoteAvailableReason.NotUpgraded,
      },
      {
        name: 'not_upgraded when leaf has empty quoteSigners',
        opts: { feeConfig: offchainQuotedLeaf([]) },
        reason: NoQuoteAvailableReason.NotUpgraded,
      },
      {
        name: 'not_authorized when signer is not on the whitelist',
        opts: { feeConfig: offchainQuotedLeaf([OTHER_SIGNER]) },
        reason: NoQuoteAvailableReason.NotAuthorized,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const svc = createTestService(c.opts);
        await expectNoQuoteReason(
          svc.getWarpQuote({ ...baseWarpReq, binding: TRANSIENT_BINDING }),
          c.reason,
        );
      });
    }
  });

  describe('getIgpQuote', () => {
    it('returns a 68B IGP context + 33B IGP data', async () => {
      const svc = createTestService();
      const entry = await svc.getIgpQuote({
        ...baseIgpReq,
        binding: TRANSIENT_BINDING,
      });
      assertSealevelEntry(entry, IGP_ACCOUNT_PDA);
      expect(entry.details.signedQuote.context).to.have.lengthOf(
        HEX_IGP_CONTEXT_LEN,
      );
      expect(entry.details.signedQuote.data).to.have.lengthOf(HEX_IGP_DATA_LEN);
    });
  });

  describe('getIgpQuote — 404 skip paths', () => {
    interface SkipCase {
      name: string;
      opts: RouteOpts;
      reason: NoQuoteAvailableReason;
    }
    const cases: SkipCase[] = [
      {
        name: 'not_configured when route has no IGP',
        opts: { hasIgp: false },
        reason: NoQuoteAvailableReason.NotConfigured,
      },
      {
        name: 'not_upgraded when IGP signers are empty',
        opts: { igpSigners: [] },
        reason: NoQuoteAvailableReason.NotUpgraded,
      },
      {
        name: 'not_authorized when our signer is not on the IGP whitelist',
        opts: { igpSigners: [OTHER_SIGNER] },
        reason: NoQuoteAvailableReason.NotAuthorized,
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const svc = createTestService(c.opts);
        await expectNoQuoteReason(
          svc.getIgpQuote({ ...baseIgpReq, binding: TRANSIENT_BINDING }),
          c.reason,
        );
      });
    }
  });
});
