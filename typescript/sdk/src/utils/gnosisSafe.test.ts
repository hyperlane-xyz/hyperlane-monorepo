import { OperationType } from '@safe-global/safe-core-sdk-types';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { describe, it } from 'mocha';
import { encodeFunctionData, parseAbi } from 'viem';

import { ISafe__factory } from '@hyperlane-xyz/core';

import { asHex, decodeMultiSendData, parseSafeTx } from './gnosisSafe.js';

describe('gnosisSafe parsing functions', () => {
  describe('parseSafeTx', () => {
    it('should parse swapOwner transaction', () => {
      const safeInterface = ISafe__factory.createInterface();
      const oldOwner = '0x0000000000000000000000000000000000000002';
      const newOwner = '0x0000000000000000000000000000000000000004';
      const prevOwner = '0x0000000000000000000000000000000000000001';

      const data = safeInterface.encodeFunctionData('swapOwner', [
        prevOwner,
        oldOwner,
        newOwner,
      ]);

      const tx = {
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      };

      const decoded = parseSafeTx(tx as any);

      expect(decoded.name).to.equal('swapOwner');
      expect(decoded.args).to.have.lengthOf(3);
      expect(decoded.args[0]).to.equal(prevOwner);
      expect(decoded.args[1]).to.equal(oldOwner);
      expect(decoded.args[2]).to.equal(newOwner);
    });

    it('should parse addOwnerWithThreshold transaction', () => {
      const safeInterface = ISafe__factory.createInterface();
      const newOwner = '0x0000000000000000000000000000000000000005';
      const threshold = 2;

      const data = safeInterface.encodeFunctionData('addOwnerWithThreshold', [
        newOwner,
        threshold,
      ]);

      const tx = {
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      };

      const decoded = parseSafeTx(tx as any);

      expect(decoded.name).to.equal('addOwnerWithThreshold');
      expect(decoded.args).to.have.lengthOf(2);
      expect(decoded.args[0]).to.equal(newOwner);
      expect(decoded.args[1].toNumber()).to.equal(threshold);
    });

    it('should parse changeThreshold transaction', () => {
      const safeInterface = ISafe__factory.createInterface();
      const newThreshold = 3;

      const data = safeInterface.encodeFunctionData('changeThreshold', [
        newThreshold,
      ]);

      const tx = {
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      };

      const decoded = parseSafeTx(tx as any);

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args).to.have.lengthOf(1);
      expect(decoded.args[0].toNumber()).to.equal(newThreshold);
    });
  });

  describe('asHex', () => {
    it('should convert hex string without 0x prefix', () => {
      const result = asHex('1234abcd');
      expect(result).to.equal('0x1234abcd');
    });

    it('should preserve hex string with 0x prefix', () => {
      const result = asHex('0x1234abcd');
      expect(result).to.equal('0x1234abcd');
    });

    it('should handle uppercase hex', () => {
      const result = asHex('0xABCDEF');
      expect(result).to.equal('0xABCDEF');
    });

    it('should handle mixed case hex', () => {
      const result = asHex('0xAbCdEf');
      expect(result).to.equal('0xAbCdEf');
    });

    it('should handle empty string', () => {
      const result = asHex('');
      expect(result).to.equal('0x');
    });

    it('should handle undefined', () => {
      const result = asHex(undefined);
      expect(result).to.equal('0xundefined');
    });
  });

  describe('decodeMultiSendData', () => {
    it('should decode single transaction', () => {
      const to = '0x1111111111111111111111111111111111111111';
      const operation = OperationType.Call;

      const txData =
        operation.toString(16).padStart(2, '0') +
        to.slice(2).toLowerCase() +
        '0'.padStart(64, '0') +
        '0'.padStart(64, '0');

      const multiSendData = encodeFunctionData({
        abi: parseAbi([
          'function multiSend(bytes memory transactions) public payable',
        ]),
        functionName: 'multiSend',
        args: [`0x${txData}` as `0x${string}`],
      });

      const decoded = decodeMultiSendData(multiSendData);

      expect(decoded).to.have.lengthOf(1);
      expect(decoded[0].to).to.equal(
        '0x1111111111111111111111111111111111111111',
      );
      expect(decoded[0].data).to.equal('0x');
      expect(decoded[0].operation).to.equal(OperationType.Call);
    });

    it('should handle delegatecall operation type', () => {
      const to = '0x1111111111111111111111111111111111111111';
      const operation = OperationType.DelegateCall;

      const txData =
        operation.toString(16).padStart(2, '0') +
        to.slice(2).toLowerCase() +
        '0'.padStart(64, '0') +
        '0'.padStart(64, '0');

      const multiSendData = encodeFunctionData({
        abi: parseAbi([
          'function multiSend(bytes memory transactions) public payable',
        ]),
        functionName: 'multiSend',
        args: [`0x${txData}` as `0x${string}`],
      });

      const decoded = decodeMultiSendData(multiSendData);

      expect(decoded).to.have.lengthOf(1);
      expect(decoded[0].operation).to.equal(OperationType.DelegateCall);
    });
  });
});
