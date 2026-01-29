import Sinon, { type SinonStub } from 'sinon';

import type {
  BridgeQuote,
  BridgeTransferStatus,
} from '../interfaces/IExternalBridge.js';

/**
 * Create mock functions for LiFi SDK.
 */
export function createLiFiSdkMocks() {
  return {
    createConfig: Sinon.stub(),
    getQuote: Sinon.stub(),
    executeRoute: Sinon.stub(),
    getStatus: Sinon.stub(),
    convertQuoteToRoute: Sinon.stub().callsFake((quote: unknown) => {
      const q = quote as Record<string, unknown> & {
        action?: { fromChainId?: number; toChainId?: number };
      };
      return {
        ...q,
        fromChainId: q.action?.fromChainId ?? 42161,
        toChainId: q.action?.toChainId ?? 1399811149,
        steps: [],
      };
    }),
  };
}

/**
 * Configure a mock getQuote to return a successful quote.
 */
export function mockSuccessfulQuote(
  stub: SinonStub,
  overrides?: Partial<{
    id: string;
    tool: string;
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
    executionDuration: number;
    fromChainId: number;
    toChainId: number;
  }>,
) {
  const fromChainId = overrides?.fromChainId ?? 42161;
  const toChainId = overrides?.toChainId ?? 1399811149;
  const fromAmount = overrides?.fromAmount ?? '10000000000';
  const toAmount = overrides?.toAmount ?? '9950000000';
  const toAmountMin = overrides?.toAmountMin ?? '9900000000';

  stub.resolves({
    id: overrides?.id ?? 'quote-123',
    tool: overrides?.tool ?? 'across',
    action: {
      fromAmount,
      fromChainId,
      toChainId,
    },
    estimate: {
      toAmount,
      toAmountMin,
      executionDuration: overrides?.executionDuration ?? 300,
    },
  });
}

/**
 * Configure a mock executeRoute to return a successful execution.
 */
export function mockSuccessfulExecution(stub: SinonStub, txHash: string) {
  stub.resolves({
    steps: [
      {
        execution: {
          process: [{ txHash }],
        },
      },
    ],
  });
}

/**
 * Configure a mock getStatus to return a specific status.
 */
export function mockLiFiStatus(
  stub: SinonStub,
  status: 'DONE' | 'PENDING' | 'FAILED' | 'NOT_FOUND',
  overrides?: Partial<{
    receivingTxHash: string;
    amount: string;
    substatus: string;
  }>,
) {
  const responses: Record<string, unknown> = {
    DONE: {
      status: 'DONE',
      receiving: {
        txHash: overrides?.receivingTxHash ?? '0xReceivingTxHash',
        amount: overrides?.amount ?? '9950000000',
      },
    },
    PENDING: {
      status: 'PENDING',
      substatus: overrides?.substatus ?? 'WAIT_SOURCE_CONFIRMATIONS',
    },
    FAILED: {
      status: 'FAILED',
      substatus: overrides?.substatus ?? 'BRIDGE_CALL_FAILED',
    },
    NOT_FOUND: {
      status: 'NOT_FOUND',
    },
  };

  stub.resolves(responses[status]);
}

/**
 * Create a mock BridgeQuote for testing.
 */
export function createMockBridgeQuote(
  overrides?: Partial<BridgeQuote>,
): BridgeQuote {
  return {
    id: 'quote-123',
    tool: 'across',
    fromAmount: 10000000000n,
    toAmount: 9950000000n,
    toAmountMin: 9900000000n,
    executionDuration: 300,
    route: {
      action: { fromChainId: 42161, toChainId: 1399811149 },
    },
    ...overrides,
  };
}

/**
 * Create a mock BridgeTransferStatus for testing.
 */
export function createMockBridgeStatus(
  status: 'pending' | 'complete' | 'failed' | 'not_found',
  overrides?: Partial<{
    substatus: string;
    receivingTxHash: string;
    receivedAmount: bigint;
    error: string;
  }>,
): BridgeTransferStatus {
  switch (status) {
    case 'pending':
      return {
        status: 'pending',
        substatus: overrides?.substatus,
      };
    case 'complete':
      return {
        status: 'complete',
        receivingTxHash: overrides?.receivingTxHash ?? '0xReceivingTxHash',
        receivedAmount: overrides?.receivedAmount ?? 9950000000n,
      };
    case 'failed':
      return {
        status: 'failed',
        error: overrides?.error,
      };
    case 'not_found':
      return { status: 'not_found' };
  }
}
