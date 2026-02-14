import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';

import { ISafe__factory } from '@hyperlane-xyz/core';

import {
  decodeMultiSendData,
  getKnownMultiSendAddresses,
  getOwnerChanges,
  isLegacySafeApi,
  normalizeSafeServiceUrl,
  parseSafeTx,
  safeApiKeyRequired,
} from './gnosisSafe.js';

describe('gnosisSafe utils', () => {
  describe(safeApiKeyRequired.name, () => {
    it('returns true for safe.global urls', () => {
      expect(
        safeApiKeyRequired('https://safe-transaction-mainnet.safe.global/api'),
      ).to.equal(true);
    });

    it('returns true for 5afe.dev urls', () => {
      expect(
        safeApiKeyRequired('https://safe-transaction-mainnet.5afe.dev/api'),
      ).to.equal(true);
    });

    it('returns false for custom tx service urls', () => {
      expect(
        safeApiKeyRequired('https://transaction.safe.somechain.com/api'),
      ).to.equal(false);
    });
  });

  describe(normalizeSafeServiceUrl.name, () => {
    it('appends /api when missing', () => {
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth'),
      ).to.equal('https://safe.global/tx-service/eth/api');
    });

    it('preserves /api when already present', () => {
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth/api'),
      ).to.equal('https://safe.global/tx-service/eth/api');
    });

    it('removes trailing slashes before appending', () => {
      expect(
        normalizeSafeServiceUrl('https://transaction.foo.xyz///'),
      ).to.equal('https://transaction.foo.xyz/api');
    });
  });

  describe(isLegacySafeApi.name, () => {
    it('detects legacy versions', async () => {
      expect(await isLegacySafeApi('5.17.9')).to.equal(true);
    });

    it('accepts minimum version', async () => {
      expect(await isLegacySafeApi('5.18.0')).to.equal(false);
    });

    it('accepts newer versions', async () => {
      expect(await isLegacySafeApi('5.19.1')).to.equal(false);
    });
  });

  describe(getOwnerChanges.name, () => {
    it('diffs owners case-insensitively', async () => {
      const currentOwners = [
        '0xaBcd000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ];
      const expectedOwners = [
        '0xabcd000000000000000000000000000000000001',
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
        '0x0000000000000000000000000000000000000003',
      ]);
    });

    it('returns empty arrays when owners are unchanged', async () => {
      const owners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        owners,
        owners,
      );

      expect(ownersToRemove).to.deep.equal([]);
      expect(ownersToAdd).to.deep.equal([]);
    });

    it('handles multiple replacements', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        '0x0000000000000000000000000000000000000004',
      ];
      const expectedOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000005',
        '0x0000000000000000000000000000000000000006',
        '0x0000000000000000000000000000000000000004',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      expect(ownersToRemove).to.deep.equal([
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
      ]);
      expect(ownersToAdd).to.deep.equal([
        '0x0000000000000000000000000000000000000005',
        '0x0000000000000000000000000000000000000006',
      ]);
    });
  });

  describe(parseSafeTx.name, () => {
    it('parses swapOwner tx calldata', () => {
      const safeInterface = ISafe__factory.createInterface();
      const prevOwner = '0x0000000000000000000000000000000000000001';
      const oldOwner = '0x0000000000000000000000000000000000000002';
      const newOwner = '0x0000000000000000000000000000000000000004';
      const data = safeInterface.encodeFunctionData('swapOwner', [
        prevOwner,
        oldOwner,
        newOwner,
      ]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('swapOwner');
      expect(decoded.args[0]).to.equal(prevOwner);
      expect(decoded.args[1]).to.equal(oldOwner);
      expect(decoded.args[2]).to.equal(newOwner);
    });

    it('parses addOwnerWithThreshold tx calldata', () => {
      const safeInterface = ISafe__factory.createInterface();
      const newOwner = '0x0000000000000000000000000000000000000005';
      const threshold = 2;
      const data = safeInterface.encodeFunctionData('addOwnerWithThreshold', [
        newOwner,
        threshold,
      ]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('addOwnerWithThreshold');
      expect(decoded.args[0]).to.equal(newOwner);
      expect(decoded.args[1].toNumber()).to.equal(threshold);
    });

    it('parses changeThreshold tx calldata', () => {
      const safeInterface = ISafe__factory.createInterface();
      const newThreshold = 3;
      const data = safeInterface.encodeFunctionData('changeThreshold', [
        newThreshold,
      ]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args[0].toNumber()).to.equal(newThreshold);
    });
  });

  describe(decodeMultiSendData.name, () => {
    function encodeMultiSendTx(params: {
      operation: number;
      to: string;
      value: bigint;
      data: `0x${string}`;
    }): string {
      const operationHex = params.operation.toString(16).padStart(2, '0');
      const toHex = params.to.replace('0x', '').padStart(40, '0');
      const valueHex = params.value.toString(16).padStart(64, '0');
      const dataHex = params.data.replace('0x', '');
      const dataLengthHex = (dataHex.length / 2).toString(16).padStart(64, '0');
      return `${operationHex}${toHex}${valueHex}${dataLengthHex}${dataHex}`;
    }

    it('decodes multisend payload', () => {
      const to = '0x00000000000000000000000000000000000000aa';
      const txBytes = `0x${encodeMultiSendTx({
        operation: 0,
        to,
        value: 7n,
        data: '0x1234',
      })}` as `0x${string}`;

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [txBytes],
      });

      const decoded = decodeMultiSendData(encoded);
      expect(decoded).to.have.length(1);
      expect(decoded[0].operation).to.equal(0);
      expect(decoded[0].to).to.equal(getAddress(to));
      expect(decoded[0].value).to.equal('7');
      expect(decoded[0].data).to.equal('0x1234');
    });
  });

  describe(getKnownMultiSendAddresses.name, () => {
    it('returns known deployment addresses for multisend contracts', () => {
      const deployments = getKnownMultiSendAddresses();
      expect(deployments.multiSend.length).to.be.greaterThan(0);
      expect(deployments.multiSendCallOnly.length).to.be.greaterThan(0);
    });
  });
});
