import { expect } from 'chai';
import { BigNumber, ethers, providers } from 'ethers';

import { InterchainGasPaymaster__factory } from '@hyperlane-xyz/core';
import {
  DispatchedMessage,
  GasPaymentEnforcementPolicyType,
  GasPolicyStatus,
  HookType,
  HyperlaneCore,
} from '@hyperlane-xyz/sdk';
import { Address, WithAddress } from '@hyperlane-xyz/utils';

import { HyperlaneRelayer } from './HyperlaneRelayer.js';

// Mock HyperlaneCore with minimal implementation
function createMockCore(): HyperlaneCore {
  return {
    multiProvider: {
      getChainName: () => 'test',
    },
    logger: {
      child: () => ({
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
        trace: () => {},
      }),
    },
  } as unknown as HyperlaneCore;
}

// Create a mock message
function createMockMessage(
  overrides: Partial<DispatchedMessage> = {},
): DispatchedMessage {
  return {
    id: '0x1111111111111111111111111111111111111111111111111111111111111111',
    parsed: {
      version: 0,
      nonce: 0,
      origin: 1,
      sender:
        '0x0000000000000000000000001234567890123456789012345678901234567890',
      destination: 2,
      recipient:
        '0x0000000000000000000000000987654321098765432109876543210987654321',
      body: '0x',
      ...overrides.parsed,
    },
    message: '0x',
    ...overrides,
  } as DispatchedMessage;
}

// Create mock hook config with IGP
function createMockHookWithIgp(
  igpAddress: Address,
): WithAddress<{ type: HookType }> {
  return {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    address: igpAddress,
  } as WithAddress<{ type: HookType }>;
}

// Create a properly encoded GasPayment event log
function createGasPaymentLog(
  igpAddress: Address,
  messageId: string,
  destinationDomain: number,
  gasAmount: bigint,
  payment: bigint,
): providers.Log {
  const iface = InterchainGasPaymaster__factory.createInterface();

  // Encode the event
  const eventFragment = iface.getEvent('GasPayment');
  const topics = iface.encodeFilterTopics(eventFragment, [
    messageId,
    destinationDomain,
  ]);

  // Encode non-indexed parameters (gasAmount, payment)
  const data = ethers.utils.defaultAbiCoder.encode(
    ['uint256', 'uint256'],
    [BigNumber.from(gasAmount.toString()), BigNumber.from(payment.toString())],
  );

  return {
    address: igpAddress,
    topics: topics as string[],
    data,
    blockNumber: 1,
    blockHash: '0x',
    transactionHash: '0x',
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

// Create mock dispatch tx with gas payment logs
function createMockDispatchTx(
  logs: providers.Log[],
): providers.TransactionReceipt {
  return {
    logs,
    to: '0x',
    from: '0x',
    contractAddress: '0x',
    transactionIndex: 0,
    gasUsed: BigNumber.from(0),
    logsBloom: '0x',
    blockHash: '0x',
    transactionHash: '0x',
    blockNumber: 1,
    confirmations: 1,
    cumulativeGasUsed: BigNumber.from(0),
    effectiveGasPrice: BigNumber.from(0),
    byzantium: true,
    type: 0,
    status: 1,
  };
}

describe('HyperlaneRelayer', () => {
  describe('checkGasPayment with OnChainFeeQuoting', () => {
    const igpAddress = '0x1234567890123456789012345678901234567890';
    const messageId =
      '0x1111111111111111111111111111111111111111111111111111111111111111';
    const destination = 2;

    function createRelayer(gasPaymentEnforcement: any[]): HyperlaneRelayer {
      return new HyperlaneRelayer({
        core: createMockCore(),
        gasPaymentEnforcement,
      });
    }

    describe('when gas estimate is available', () => {
      it('should return PolicyMet when gasAmount meets required fraction (1/2)', async () => {
        const gasEstimate = '100000';
        const gasAmount = BigInt(50000); // exactly 50%
        const payment = BigInt(1000000000000000);

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 2 },
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          destination,
          gasAmount,
          payment,
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyMet);
      });

      it('should return PolicyMet when gasAmount exceeds required fraction', async () => {
        const gasEstimate = '100000';
        const gasAmount = BigInt(75000); // 75% > 50%
        const payment = BigInt(1000000000000000);

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 2 },
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          destination,
          gasAmount,
          payment,
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyMet);
      });

      it('should return PolicyNotMet when gasAmount is below required fraction', async () => {
        const gasEstimate = '100000';
        const gasAmount = BigInt(49999); // just under 50%
        const payment = BigInt(1000000000000000);

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 2 },
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          destination,
          gasAmount,
          payment,
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyNotMet);
      });

      it('should respect custom gasFraction (3/4 = 75%)', async () => {
        const gasEstimate = '100000';
        const gasAmount = BigInt(74999); // just under 75%
        const payment = BigInt(1000000000000000);

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 3, denominator: 4 },
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          destination,
          gasAmount,
          payment,
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyNotMet);
      });

      it('should handle 1/1 gasFraction (100% required)', async () => {
        const gasEstimate = '100000';
        const gasAmount = BigInt(100000); // exactly 100%
        const payment = BigInt(1000000000000000);

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 1 },
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          destination,
          gasAmount,
          payment,
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyMet);
      });
    });

    describe('when gas estimate is unavailable (ZkSync)', () => {
      it('should return PolicyNotMet when gasEstimate is "0"', async () => {
        const gasEstimate = '0';
        const gasAmount = BigInt(100000);
        const payment = BigInt(1000000000000000);

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 2 },
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          destination,
          gasAmount,
          payment,
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyNotMet);
      });
    });

    describe('when no payment is found', () => {
      it('should return NoPaymentFound when no matching payment exists', async () => {
        const gasEstimate = '100000';
        const differentMessageId =
          '0x2222222222222222222222222222222222222222222222222222222222222222';

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 2 },
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        // Create log with payment for different message
        const log = createGasPaymentLog(
          igpAddress,
          differentMessageId,
          destination,
          BigInt(100000),
          BigInt(1000000000000000),
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.NoPaymentFound);
      });

      it('should return NoPaymentFound when destination does not match', async () => {
        const gasEstimate = '100000';
        const wrongDestination = 999;

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 2 },
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          wrongDestination,
          BigInt(100000),
          BigInt(1000000000000000),
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.NoPaymentFound);
      });
    });

    describe('policy matching', () => {
      it('should return PolicyMet when no policy matches', async () => {
        const gasEstimate = '100000';

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 2 },
            matchingList: [{ originDomain: 999 }], // Won't match origin=1
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const dispatchTx = createMockDispatchTx([]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyMet);
      });

      it('should use first matching policy', async () => {
        const gasEstimate = '100000';
        const gasAmount = BigInt(30000); // 30%

        const relayer = createRelayer([
          {
            // First policy: requires 50% but only for origin=999
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 2 },
            matchingList: [{ originDomain: 999 }],
          },
          {
            // Second policy: requires only 25%, matches all
            type: GasPaymentEnforcementPolicyType.OnChainFeeQuoting,
            gasFraction: { numerator: 1, denominator: 4 },
          },
        ]);

        const message = createMockMessage({ id: messageId }); // origin=1
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          destination,
          gasAmount,
          BigInt(1000000000000000),
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        // Second policy matches, 30% > 25% required
        expect(result).to.equal(GasPolicyStatus.PolicyMet);
      });
    });

    describe('None policy', () => {
      it('should return PolicyMet for None policy regardless of payment', async () => {
        const gasEstimate = '100000';

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.None,
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const dispatchTx = createMockDispatchTx([]); // No payment

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyMet);
      });
    });

    describe('Minimum policy', () => {
      it('should return PolicyMet when payment meets minimum', async () => {
        const gasEstimate = '100000';
        const minPayment = BigInt(1000000000000000); // 0.001 ETH
        const actualPayment = BigInt(1000000000000000);

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.Minimum,
            payment: minPayment.toString(),
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          destination,
          BigInt(100000),
          actualPayment,
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyMet);
      });

      it('should return PolicyNotMet when payment is below minimum', async () => {
        const gasEstimate = '100000';
        const minPayment = BigInt(1000000000000000);
        const actualPayment = BigInt(999999999999999); // just under

        const relayer = createRelayer([
          {
            type: GasPaymentEnforcementPolicyType.Minimum,
            payment: minPayment.toString(),
          },
        ]);

        const message = createMockMessage({ id: messageId });
        const hook = createMockHookWithIgp(igpAddress);
        const log = createGasPaymentLog(
          igpAddress,
          messageId,
          destination,
          BigInt(100000),
          actualPayment,
        );
        const dispatchTx = createMockDispatchTx([log]);

        const result = await relayer.checkGasPayment(
          message,
          dispatchTx,
          hook,
          gasEstimate,
        );

        expect(result).to.equal(GasPolicyStatus.PolicyNotMet);
      });
    });
  });
});
