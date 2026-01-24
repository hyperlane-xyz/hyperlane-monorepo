import { OperationType } from '@safe-global/safe-core-sdk-types';
import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { ISafe__factory } from '@hyperlane-xyz/core';

import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';

import {
  decodeMultiSendData,
  formatOperationType,
  getOwnerChanges,
  getSafeTxStatus,
  metaTransactionDataToEV5Transaction,
  parseSafeTx,
} from './safe.js';
import { SafeTxStatus } from './types.js';

describe('Safe Transaction Parsing', () => {
  describe('getOwnerChanges', () => {
    it('should identify owners to add and remove', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
      ];
      const expectedOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000004', // new owner
        '0x0000000000000000000000000000000000000003',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      expect(ownersToRemove).to.deep.equal([
        '0x0000000000000000000000000000000000000002',
      ]);
      expect(ownersToAdd).to.deep.equal([
        '0x0000000000000000000000000000000000000004',
      ]);
    });

    it('should return empty arrays when no changes', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        currentOwners,
      );

      expect(ownersToRemove).to.deep.equal([]);
      expect(ownersToAdd).to.deep.equal([]);
    });

    it('should handle multiple swaps', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        '0x0000000000000000000000000000000000000004',
      ];
      const expectedOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000005', // replace 0x02
        '0x0000000000000000000000000000000000000006', // replace 0x03
        '0x0000000000000000000000000000000000000004',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      expect(ownersToRemove).to.have.lengthOf(2);
      expect(ownersToAdd).to.have.lengthOf(2);
      expect(ownersToRemove).to.include(
        '0x0000000000000000000000000000000000000002',
      );
      expect(ownersToRemove).to.include(
        '0x0000000000000000000000000000000000000003',
      );
      expect(ownersToAdd).to.include(
        '0x0000000000000000000000000000000000000005',
      );
      expect(ownersToAdd).to.include(
        '0x0000000000000000000000000000000000000006',
      );
    });

    it('should be case-insensitive for addresses', async () => {
      const currentOwners = [
        '0xaBcd000000000000000000000000000000000001', // correctly checksummed
        '0x0000000000000000000000000000000000000002',
      ];
      const expectedOwners = [
        '0xabcd000000000000000000000000000000000001', // same address, lowercase
        '0x0000000000000000000000000000000000000003', // new
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      // eqAddress normalizes addresses, so the checksummed and lowercase versions should be treated as the same
      expect(ownersToRemove).to.have.lengthOf(1);
      expect(ownersToAdd).to.have.lengthOf(1);
      expect(ownersToRemove[0].toLowerCase()).to.equal(
        '0x0000000000000000000000000000000000000002',
      );
      expect(ownersToAdd[0].toLowerCase()).to.equal(
        '0x0000000000000000000000000000000000000003',
      );
    });
  });

  describe('parseSafeTx', () => {
    it('should parse swapOwner transaction using ISafe interface', () => {
      const safeInterface = ISafe__factory.createInterface();
      const oldOwner = '0x0000000000000000000000000000000000000002';
      const newOwner = '0x0000000000000000000000000000000000000004';
      const prevOwner = '0x0000000000000000000000000000000000000001';

      const data = safeInterface.encodeFunctionData('swapOwner', [
        prevOwner,
        oldOwner,
        newOwner,
      ]);

      const tx: AnnotatedEV5Transaction = {
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      };

      const decoded = parseSafeTx(tx);

      expect(decoded.name).to.equal('swapOwner');
      expect(decoded.args).to.have.lengthOf(3);
      expect(decoded.args[0]).to.equal(prevOwner);
      expect(decoded.args[1]).to.equal(oldOwner);
      expect(decoded.args[2]).to.equal(newOwner);
    });

    it('should parse addOwnerWithThreshold transaction using ISafe interface', () => {
      const safeInterface = ISafe__factory.createInterface();
      const newOwner = '0x0000000000000000000000000000000000000005';
      const threshold = 2;

      const data = safeInterface.encodeFunctionData('addOwnerWithThreshold', [
        newOwner,
        threshold,
      ]);

      const tx: AnnotatedEV5Transaction = {
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      };

      const decoded = parseSafeTx(tx);

      expect(decoded.name).to.equal('addOwnerWithThreshold');
      expect(decoded.args).to.have.lengthOf(2);
      expect(decoded.args[0]).to.equal(newOwner);
      expect(decoded.args[1].toNumber()).to.equal(threshold);
    });

    it('should parse changeThreshold transaction using ISafe interface', () => {
      const safeInterface = ISafe__factory.createInterface();
      const newThreshold = 3;

      const data = safeInterface.encodeFunctionData('changeThreshold', [
        newThreshold,
      ]);

      const tx: AnnotatedEV5Transaction = {
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      };

      const decoded = parseSafeTx(tx);

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args).to.have.lengthOf(1);
      expect(decoded.args[0].toNumber()).to.equal(newThreshold);
    });
  });

  describe('getSafeTxStatus', () => {
    it('should return READY_TO_EXECUTE when confirmations >= threshold', () => {
      expect(getSafeTxStatus(3, 3)).to.equal(SafeTxStatus.READY_TO_EXECUTE);
      expect(getSafeTxStatus(4, 3)).to.equal(SafeTxStatus.READY_TO_EXECUTE);
    });

    it('should return NO_CONFIRMATIONS when confirmations is 0', () => {
      expect(getSafeTxStatus(0, 3)).to.equal(SafeTxStatus.NO_CONFIRMATIONS);
    });

    it('should return ONE_AWAY when one confirmation away from threshold', () => {
      expect(getSafeTxStatus(2, 3)).to.equal(SafeTxStatus.ONE_AWAY);
    });

    it('should return PENDING otherwise', () => {
      expect(getSafeTxStatus(1, 3)).to.equal(SafeTxStatus.PENDING);
      expect(getSafeTxStatus(1, 4)).to.equal(SafeTxStatus.PENDING);
    });
  });

  describe('formatOperationType', () => {
    it('should format Call operation', () => {
      expect(formatOperationType(OperationType.Call)).to.equal('Call');
    });

    it('should format DelegateCall operation', () => {
      expect(formatOperationType(OperationType.DelegateCall)).to.equal(
        'Delegate Call',
      );
    });

    it('should format undefined as Unknown', () => {
      expect(formatOperationType(undefined)).to.equal('Unknown');
    });
  });

  describe('metaTransactionDataToEV5Transaction', () => {
    it('should convert MetaTransactionData to AnnotatedEV5Transaction', () => {
      const metaTx = {
        to: '0x1234567890123456789012345678901234567890',
        value: '1000000000000000000',
        data: '0x1234',
        operation: OperationType.Call,
      };

      const result = metaTransactionDataToEV5Transaction(metaTx);

      expect(result.to).to.equal(metaTx.to);
      expect(result.value?.toString()).to.equal(metaTx.value);
      expect(result.data).to.equal(metaTx.data);
    });
  });

  describe('decodeMultiSendData', () => {
    it('should decode a single transaction from MultiSend data', () => {
      // Manually construct MultiSend data for a single transaction
      // Format: operation (1 byte) + to (20 bytes) + value (32 bytes) + dataLength (32 bytes) + data

      const targetAddress = '0x1234567890123456789012345678901234567890';
      const value = BigNumber.from(0);
      const calldata = '0xabcd';

      // Build the inner transaction bytes
      const operation = '00'; // Call
      const toHex = targetAddress.slice(2).toLowerCase();
      const valueHex = value.toHexString().slice(2).padStart(64, '0');
      const dataLength = ((calldata.length - 2) / 2)
        .toString(16)
        .padStart(64, '0');
      const dataHex = calldata.slice(2);

      const transactionBytes =
        '0x' + operation + toHex + valueHex + dataLength + dataHex;

      // Encode as multiSend call
      const multiSendInterface = new (require('ethers').utils.Interface)([
        'function multiSend(bytes memory transactions) public payable',
      ]);
      const encodedMultiSend = multiSendInterface.encodeFunctionData(
        'multiSend',
        [transactionBytes],
      );

      const decoded = decodeMultiSendData(encodedMultiSend);

      expect(decoded).to.have.lengthOf(1);
      expect(decoded[0].to.toLowerCase()).to.equal(targetAddress.toLowerCase());
      expect(decoded[0].value).to.equal('0');
      expect(decoded[0].data.toLowerCase()).to.equal(calldata.toLowerCase());
      expect(decoded[0].operation).to.equal(OperationType.Call);
    });
  });
});
