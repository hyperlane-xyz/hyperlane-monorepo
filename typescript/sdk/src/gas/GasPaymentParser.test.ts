import { expect } from 'chai';

import {
  aggregateGasPayments,
  getGasPaymentForMessage,
} from './GasPaymentParser.js';
import type { InterchainGasPayment } from './types.js';

// Note: parseGasPaymentsFromReceipt requires actual contract ABI parsing,
// which is better tested in hardhat integration tests. Here we test the
// pure utility functions.

describe('GasPaymentParser', () => {
  describe('getGasPaymentForMessage', () => {
    const payments: InterchainGasPayment[] = [
      {
        messageId:
          '0x1111111111111111111111111111111111111111111111111111111111111111',
        destination: 1,
        gasAmount: BigInt(100000),
        payment: BigInt(1000000000000000),
      },
      {
        messageId:
          '0x2222222222222222222222222222222222222222222222222222222222222222',
        destination: 2,
        gasAmount: BigInt(200000),
        payment: BigInt(2000000000000000),
      },
      {
        messageId:
          '0x1111111111111111111111111111111111111111111111111111111111111111',
        destination: 1,
        gasAmount: BigInt(50000),
        payment: BigInt(500000000000000),
      },
    ];

    it('should return payment matching messageId and destination', () => {
      const result = getGasPaymentForMessage(
        payments,
        '0x2222222222222222222222222222222222222222222222222222222222222222',
        2,
      );
      expect(result).to.not.be.undefined;
      expect(result!.gasAmount).to.equal(BigInt(200000));
      expect(result!.payment).to.equal(BigInt(2000000000000000));
    });

    it('should return undefined when no match found', () => {
      const result = getGasPaymentForMessage(
        payments,
        '0x3333333333333333333333333333333333333333333333333333333333333333',
        1,
      );
      expect(result).to.be.undefined;
    });

    it('should return undefined when destination does not match', () => {
      const result = getGasPaymentForMessage(
        payments,
        '0x1111111111111111111111111111111111111111111111111111111111111111',
        99, // Wrong destination
      );
      expect(result).to.be.undefined;
    });

    it('should aggregate multiple payments for same message', () => {
      const result = getGasPaymentForMessage(
        payments,
        '0x1111111111111111111111111111111111111111111111111111111111111111',
        1,
      );
      expect(result).to.not.be.undefined;
      // Should aggregate: 100000 + 50000 = 150000
      expect(result!.gasAmount).to.equal(BigInt(150000));
      // Should aggregate: 1000000000000000 + 500000000000000 = 1500000000000000
      expect(result!.payment).to.equal(BigInt(1500000000000000));
    });

    it('should match messageId case-insensitively', () => {
      const result = getGasPaymentForMessage(
        payments,
        '0x2222222222222222222222222222222222222222222222222222222222222222'.toUpperCase(),
        2,
      );
      expect(result).to.not.be.undefined;
      expect(result!.gasAmount).to.equal(BigInt(200000));
    });

    it('should return undefined for empty payments array', () => {
      const result = getGasPaymentForMessage(
        [],
        '0x1111111111111111111111111111111111111111111111111111111111111111',
        1,
      );
      expect(result).to.be.undefined;
    });
  });

  describe('aggregateGasPayments', () => {
    it('should sum gasAmount and payment for multiple payments', () => {
      const payments: InterchainGasPayment[] = [
        {
          messageId: '0x1111',
          destination: 1,
          gasAmount: BigInt(100),
          payment: BigInt(1000),
        },
        {
          messageId: '0x1111',
          destination: 1,
          gasAmount: BigInt(200),
          payment: BigInt(2000),
        },
        {
          messageId: '0x1111',
          destination: 1,
          gasAmount: BigInt(300),
          payment: BigInt(3000),
        },
      ];

      const result = aggregateGasPayments(payments);
      expect(result.messageId).to.equal('0x1111');
      expect(result.destination).to.equal(1);
      expect(result.gasAmount).to.equal(BigInt(600));
      expect(result.payment).to.equal(BigInt(6000));
    });

    it('should return the same payment for single element array', () => {
      const payments: InterchainGasPayment[] = [
        {
          messageId: '0x1111',
          destination: 1,
          gasAmount: BigInt(100),
          payment: BigInt(1000),
        },
      ];

      const result = aggregateGasPayments(payments);
      expect(result).to.deep.equal(payments[0]);
    });

    it('should throw for empty array', () => {
      expect(() => aggregateGasPayments([])).to.throw(
        'Cannot aggregate empty payments array',
      );
    });

    it('should handle large BigInt values', () => {
      const largeValue = BigInt('1000000000000000000000'); // 1000 ETH in wei
      const payments: InterchainGasPayment[] = [
        {
          messageId: '0x1111',
          destination: 1,
          gasAmount: largeValue,
          payment: largeValue,
        },
        {
          messageId: '0x1111',
          destination: 1,
          gasAmount: largeValue,
          payment: largeValue,
        },
      ];

      const result = aggregateGasPayments(payments);
      expect(result.gasAmount).to.equal(largeValue * BigInt(2));
      expect(result.payment).to.equal(largeValue * BigInt(2));
    });
  });
});
