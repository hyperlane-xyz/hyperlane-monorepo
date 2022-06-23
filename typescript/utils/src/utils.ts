import { assert } from 'chai';
import { ethers, utils } from 'ethers';

import { Address, Domain, HexString, ParsedMessage } from './types';

/*
 * Gets the byte length of a hex string
 *
 * @param hexStr - the hex string
 * @return byteLength - length in bytes
 */
export function getHexStringByteLength(hexStr: string) {
  let len = hexStr.length;

  // check for prefix, remove if necessary
  if (hexStr.slice(0, 2) == '0x') {
    len -= 2;
  }

  // divide by 2 to get the byte length
  return len / 2;
}

export const stringToBytes32 = (s: string): string => {
  const str = Buffer.from(s.slice(0, 32), 'utf-8');
  const result = Buffer.alloc(32);
  str.copy(result);

  return '0x' + result.toString('hex');
};

export function addressToBytes32(address: Address): string {
  return ethers.utils
    .hexZeroPad(ethers.utils.hexStripZeros(address), 32)
    .toLowerCase();
}

export function bytes32ToAddress(bytes32: string): Address {
  return ethers.utils.getAddress(bytes32.slice(-40));
}

export function formatCallData<
  C extends ethers.Contract,
  I extends Parameters<C['interface']['encodeFunctionData']>,
>(destinationContract: C, functionName: I[0], functionArgs: I[1]): string {
  return destinationContract.interface.encodeFunctionData(
    functionName,
    functionArgs,
  );
}

export const formatMessage = (
  localDomain: Domain,
  senderAddr: Address,
  destinationDomain: Domain,
  recipientAddr: Address,
  body: HexString,
): string => {
  senderAddr = addressToBytes32(senderAddr);
  recipientAddr = addressToBytes32(recipientAddr);

  return ethers.utils.solidityPack(
    ['uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [localDomain, senderAddr, destinationDomain, recipientAddr, body],
  );
};

/**
 * Parse a serialized Abacus message from raw bytes.
 *
 * @param message
 * @returns
 */
export function parseMessage(message: string): ParsedMessage {
  const buf = Buffer.from(utils.arrayify(message));
  const origin = buf.readUInt32BE(0);
  const sender = utils.hexlify(buf.slice(4, 36));
  const destination = buf.readUInt32BE(36);
  const recipient = utils.hexlify(buf.slice(40, 72));
  const body = utils.hexlify(buf.slice(72));
  return { origin, sender, destination, recipient, body };
}

export function messageHash(message: HexString, leafIndex: number): string {
  return ethers.utils.solidityKeccak256(
    ['bytes', 'uint256'],
    [message, leafIndex],
  );
}

export function destinationAndNonce(
  destination: Domain,
  sequence: number,
): ethers.BigNumber {
  assert(destination < Math.pow(2, 32) - 1);
  assert(sequence < Math.pow(2, 32) - 1);

  return ethers.BigNumber.from(destination)
    .mul(ethers.BigNumber.from(2).pow(32))
    .add(ethers.BigNumber.from(sequence));
}

export function domainHash(domain: number): string {
  return ethers.utils.solidityKeccak256(
    ['uint32', 'string'],
    [domain, 'ABACUS'],
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Retries an async function when it raises an exeption
// if all the tries fail it raises the last thrown exeption
export async function retryAsync<T>(
  runner: () => T,
  attempts = 3,
  delay = 500,
) {
  let saveError;
  for (let i = 0; i < attempts; i++) {
    try {
      return runner();
    } catch (error) {
      saveError = error;
      await sleep(delay * (i + 1));
    }
  }
  throw saveError;
}
