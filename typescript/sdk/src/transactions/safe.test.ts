import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';

import { ISafe__factory } from '@hyperlane-xyz/core';
import { OperationType } from '@safe-global/safe-core-sdk-types';

import { decodeMultiSendData, parseSafeTx } from './safe.js';

describe('parseSafeTx', () => {
  it('parses swapOwner using ISafe interface', () => {
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

    const decoded = parseSafeTx(tx);

    expect(decoded.name).to.equal('swapOwner');
    expect(decoded.args).to.have.lengthOf(3);
    expect(decoded.args[0]).to.equal(prevOwner);
    expect(decoded.args[1]).to.equal(oldOwner);
    expect(decoded.args[2]).to.equal(newOwner);
  });

  it('parses addOwnerWithThreshold using ISafe interface', () => {
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

    const decoded = parseSafeTx(tx);

    expect(decoded.name).to.equal('addOwnerWithThreshold');
    expect(decoded.args).to.have.lengthOf(2);
    expect(decoded.args[0]).to.equal(newOwner);
    expect(decoded.args[1].toNumber()).to.equal(threshold);
  });

  it('parses changeThreshold using ISafe interface', () => {
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

    const decoded = parseSafeTx(tx);

    expect(decoded.name).to.equal('changeThreshold');
    expect(decoded.args).to.have.lengthOf(1);
    expect(decoded.args[0].toNumber()).to.equal(newThreshold);
  });
});

describe('decodeMultiSendData', () => {
  it('decodes a multisend payload', () => {
    const to = '0x0000000000000000000000000000000000000011';
    const data = '0xdeadbeef';
    const encodedTx = buildMultiSendTransaction({
      operation: OperationType.Call,
      to,
      value: 0n,
      data,
    });

    const callData = encodeFunctionData({
      abi: parseAbi([
        'function multiSend(bytes memory transactions) public payable',
      ]),
      functionName: 'multiSend',
      args: [`0x${encodedTx}`],
    });

    const decoded = decodeMultiSendData(callData);

    expect(decoded).to.deep.equal([
      {
        operation: OperationType.Call,
        to: getAddress(to),
        value: '0',
        data,
      },
    ]);
  });
});

function buildMultiSendTransaction(params: {
  operation: OperationType;
  to: string;
  value: bigint;
  data: string;
}): string {
  const opHex = params.operation.toString(16).padStart(2, '0');
  const toHex = strip0x(params.to).padStart(40, '0');
  const valueHex = params.value.toString(16).padStart(64, '0');
  const dataHex = strip0x(params.data);
  const dataLength = (dataHex.length / 2).toString(16).padStart(64, '0');
  return `${opHex}${toHex}${valueHex}${dataLength}${dataHex}`;
}

function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}
