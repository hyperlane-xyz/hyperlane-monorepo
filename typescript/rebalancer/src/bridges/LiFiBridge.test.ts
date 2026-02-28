import { expect } from 'chai';
import { pino } from 'pino';

import type { LiFiStep } from '@lifi/sdk';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  ExternalBridgeConfig,
} from '../interfaces/IExternalBridge.js';
import { LiFiBridge } from './LiFiBridge.js';

const testLogger = pino({ level: 'silent' });

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const BRIDGE_CONFIG: ExternalBridgeConfig = {
  integrator: 'test-rebalancer',
};

// Use all-digit hex addresses to avoid EIP-55 checksum case mutations
const TOKEN_ADDR = '0x1234567890123456789012345678901234567890';
const SENDER_ADDR = '0x9876543210987654321098765432109876543210';
const BAD_ADDR = '0x1111111111111111111111111111111111111111';

/**
 * Creates a LiFiStep object that convertQuoteToRoute can consume.
 * The SDK's convertQuoteToRoute reads action.fromToken.chainId, action.toToken.chainId, etc.
 */
function createLiFiStep(overrides?: {
  fromChainId?: number;
  toChainId?: number;
  fromTokenAddress?: string;
  toTokenAddress?: string;
  toAddress?: string;
  fromAmount?: string;
  toAmount?: string;
  fromAddress?: string;
}): LiFiStep {
  const fromChainId = overrides?.fromChainId ?? 42161;
  const toChainId = overrides?.toChainId ?? 1399811149;
  const fromTokenAddress = overrides?.fromTokenAddress ?? TOKEN_ADDR;
  const toTokenAddress = overrides?.toTokenAddress ?? TOKEN_ADDR;
  const fromAmount = overrides?.fromAmount ?? '10000000000';
  const fromAddress = overrides?.fromAddress ?? SENDER_ADDR;
  const toAddress = overrides?.toAddress ?? SENDER_ADDR;

  return {
    id: 'quote-123',
    type: 'lifi' as const,
    tool: 'across',
    toolDetails: { key: 'across', name: 'Across', logoURI: '' },
    includedSteps: [],
    action: {
      fromToken: {
        chainId: fromChainId,
        address: fromTokenAddress,
        symbol: 'USDC',
        decimals: 6,
        name: 'USD Coin',
        priceUSD: '1',
      },
      toToken: {
        chainId: toChainId,
        address: toTokenAddress,
        symbol: 'USDC',
        decimals: 6,
        name: 'USD Coin',
        priceUSD: '1',
      },
      fromAmount,
      fromAddress,
      toAddress,
      fromChainId,
      toChainId,
      slippage: 0.005,
    },
    estimate: {
      tool: 'across',
      fromAmount,
      fromAmountUSD: '10000',
      toAmount: overrides?.toAmount ?? '9950000000',
      toAmountMin: '9900000000',
      toAmountUSD: '9950',
      approvalAddress: '0x0000000000000000000000000000000000000000',
      executionDuration: 300,
      gasCosts: [
        {
          type: 'SEND' as const,
          price: '50',
          estimate: '21000',
          limit: '26250',
          amount: '50000000',
          amountUSD: '5',
          token: {
            chainId: fromChainId,
            address: '0x0000000000000000000000000000000000000000',
            symbol: 'ETH',
            decimals: 18,
            name: 'Ethereum',
            priceUSD: '3000',
          },
        },
      ],
    },
  };
}

/**
 * Creates a BridgeQuote with matching requestParams for the default LiFi step.
 */
function createTestQuote(
  routeOverrides?: Parameters<typeof createLiFiStep>[0],
  paramOverrides?: Partial<BridgeQuoteParams>,
): BridgeQuote<LiFiStep> {
  const lifiStep = createLiFiStep(routeOverrides);

  const defaultParams: BridgeQuoteParams = {
    fromChain: 42161,
    toChain: 1399811149,
    fromToken: TOKEN_ADDR,
    toToken: TOKEN_ADDR,
    fromAddress: SENDER_ADDR,
    toAddress: SENDER_ADDR,
    fromAmount: 10000000000n,
  };

  return {
    id: 'quote-123',
    tool: 'across',
    fromAmount: 10000000000n,
    toAmount: 9950000000n,
    toAmountMin: 9900000000n,
    executionDuration: 300,
    gasCosts: 50000000n,
    feeCosts: 0n,
    route: lifiStep,
    requestParams: { ...defaultParams, ...paramOverrides },
  };
}

/**
 * Validation regex patterns used by LiFiBridge.execute() assertion messages.
 * If an error message matches any of these, it came from route validation.
 */
const VALIDATION_PATTERNS = [
  /Route fromChainId .* does not match requested/,
  /Route toChainId .* does not match requested/,
  /Route fromToken .* does not match requested/,
  /Route toToken .* does not match requested/,
  /Route toAddress .* does not match requested/,
  /Route fromAmount .* does not match requested/,
  /Route toAmount .* does not match requested/,
  /Route fromAmount must be positive/,
];

function isValidationError(msg: string): boolean {
  return VALIDATION_PATTERNS.some((pattern) => pattern.test(msg));
}

describe('LiFiBridge.execute() route validation', function () {
  // Allow extra time for tests that pass validation and reach SDK execution
  this.timeout(15000);

  let bridge: LiFiBridge;

  beforeEach(() => {
    bridge = new LiFiBridge(BRIDGE_CONFIG, testLogger);
  });

  it('should pass validation when all route fields match requestParams', async () => {
    const quote = createTestQuote();

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      // If it resolves, validation definitely passed
    } catch (error: unknown) {
      const msg = (error as Error).message;
      // Post-validation error (SDK/RPC). Verify it is NOT a route validation error.
      expect(
        isValidationError(msg),
        `Expected non-validation error but got: ${msg}`,
      ).to.equal(false);
    }
  });

  it('should throw when route fromChainId does not match requested', async () => {
    const quote = createTestQuote({ fromChainId: 999 }, { fromChain: 42161 });

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.include('999');
      expect(msg).to.include('42161');
      expect(msg).to.include('fromChainId');
    }
  });

  it('should throw when route toChainId does not match requested', async () => {
    const quote = createTestQuote({ toChainId: 888 }, { toChain: 1399811149 });

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.include('888');
      expect(msg).to.include('1399811149');
      expect(msg).to.include('toChainId');
    }
  });

  it('should throw when route fromToken does not match requested', async () => {
    const quote = createTestQuote(
      { fromTokenAddress: BAD_ADDR },
      { fromToken: TOKEN_ADDR },
    );

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.include('fromToken');
      // Error message should contain the mismatched address value
      expect(msg.toLowerCase()).to.include(BAD_ADDR.toLowerCase());
    }
  });

  it('should throw when route toToken does not match requested', async () => {
    const quote = createTestQuote(
      { toTokenAddress: BAD_ADDR },
      { toToken: TOKEN_ADDR },
    );

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.include('toToken');
      expect(msg.toLowerCase()).to.include(BAD_ADDR.toLowerCase());
    }
  });

  it('should throw when route toAddress does not match requested', async () => {
    const quote = createTestQuote(
      { toAddress: BAD_ADDR },
      { toAddress: SENDER_ADDR },
    );

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.include('toAddress');
    }
  });

  it('should pass validation when fromAmount is omitted in requestParams', async () => {
    // Route has fromAmount='99999' but requestParams has no fromAmount.
    // The fromAmount assertion is skipped when requestParams.fromAmount is undefined.
    // The positive amount check still passes (99999 > 0).
    const quote = createTestQuote(
      { fromAmount: '99999' },
      { fromAmount: undefined },
    );

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(
        isValidationError(msg),
        `Expected non-validation error but got: ${msg}`,
      ).to.equal(false);
    }
  });

  it('should throw when route fromAmount does not match requested', async () => {
    const quote = createTestQuote(
      { fromAmount: '9999999999' },
      { fromAmount: 10000000000n },
    );

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.include('9999999999');
      expect(msg).to.include('10000000000');
      expect(msg).to.include('fromAmount');
    }
  });

  it('should throw when route fromAmount is zero', async () => {
    // fromAmount=0n is falsy, so the mismatch assertion is skipped.
    // But the positive amount check catches it.
    const quote = createTestQuote(
      { fromAmount: '0' },
      { fromAmount: undefined },
    );

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.include('must be positive');
    }
  });

  it('should match addresses case-insensitively (mixed vs uppercase)', async () => {
    // Route uses lowercase a-f, requestParams uses uppercase A-F
    // Both should match after toLowerCase()
    const mixedCaseToken = '0xaabb000000000000000000000000000000001122';
    const upperCaseToken = '0xAABB000000000000000000000000000000001122';
    const mixedCaseSender = '0xddee000000000000000000000000000000003344';
    const upperCaseSender = '0xDDEE000000000000000000000000000000003344';

    const quote = createTestQuote(
      {
        fromTokenAddress: mixedCaseToken,
        toTokenAddress: mixedCaseToken,
        fromAddress: mixedCaseSender,
        toAddress: mixedCaseSender,
      },
      {
        fromToken: upperCaseToken,
        toToken: upperCaseToken,
        fromAddress: upperCaseSender,
        toAddress: upperCaseSender,
      },
    );

    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(
        isValidationError(msg),
        `Expected non-validation error but got: ${msg}`,
      ).to.equal(false);
    }
  });

  it('should throw when requestParams.fromAmount is 0n and route has positive amount', async () => {
    // Validates the fix for the fromAmount=0n truthiness bypass:
    // 0n was falsy so `if (requestParams.fromAmount)` would skip the comparison.
    // With `!== undefined`, a 0n request is correctly compared against the route amount.
    const quote = createTestQuote({ fromAmount: '1' }, { fromAmount: 0n });
    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.include('fromAmount');
    }
  });

  it('should pass validation for toAmount quote path (fromAmount undefined, toAmount present)', async () => {
    // Tests reverse-quote pattern where toAmount is set and fromAmount is undefined.
    // The fromAmount equality check is skipped when requestParams.fromAmount is undefined.
    // The toAmount equality check passes because route.toAmount matches requestParams.toAmount.
    const quote = createTestQuote(
      { fromAmount: '5000000000', toAmount: '5000000000' },
      { fromAmount: undefined, toAmount: 5000000000n },
    );
    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(
        isValidationError(msg),
        `Expected non-validation error but got: ${msg}`,
      ).to.equal(false);
    }
  });

  it('should throw when route toAmount does not match requested for reverse quote', async () => {
    // Route estimate.toAmount='9950000000' but requestParams.toAmount=123n -> mismatch
    const quote = createTestQuote(
      {},
      { fromAmount: undefined, toAmount: 123n },
    );
    try {
      await bridge.execute(quote, TEST_PRIVATE_KEY);
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      const msg = (error as Error).message;
      expect(msg).to.include('toAmount');
      expect(msg).to.include('9950000000');
      expect(msg).to.include('123');
    }
  });
});

describe('LiFiBridge.quote() input validation', function () {
  let bridge: LiFiBridge;

  beforeEach(() => {
    bridge = new LiFiBridge(BRIDGE_CONFIG, testLogger);
  });

  it('should throw when fromAmount is 0n', async () => {
    try {
      await bridge.quote({
        fromChain: 42161,
        toChain: 1399811149,
        fromToken: TOKEN_ADDR,
        toToken: TOKEN_ADDR,
        fromAddress: SENDER_ADDR,
        fromAmount: 0n,
      });
      expect.fail('Expected quote to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include(
        'fromAmount must be positive',
      );
    }
  });

  it('should throw when toAmount is 0n', async () => {
    try {
      await bridge.quote({
        fromChain: 42161,
        toChain: 1399811149,
        fromToken: TOKEN_ADDR,
        toToken: TOKEN_ADDR,
        fromAddress: SENDER_ADDR,
        toAmount: 0n,
      });
      expect.fail('Expected quote to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('toAmount must be positive');
    }
  });
});
