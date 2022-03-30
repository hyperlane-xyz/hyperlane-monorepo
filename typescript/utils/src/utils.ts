import { assert } from "chai";
import { ethers } from "ethers";
import { Domain, Address, HexString } from "./types";

/*
 * Gets the byte length of a hex string
 *
 * @param hexStr - the hex string
 * @return byteLength - length in bytes
 */
export function getHexStringByteLength(hexStr: string) {
  let len = hexStr.length;

  // check for prefix, remove if necessary
  if (hexStr.slice(0, 2) == "0x") {
    len -= 2;
  }

  // divide by 2 to get the byte length
  return len / 2;
}

export const stringToBytes32 = (s: string): string => {
  const str = Buffer.from(s.slice(0, 32), "utf-8");
  const result = Buffer.alloc(32);
  str.copy(result);

  return "0x" + result.toString("hex");
};

export function addressToBytes32(address: Address): string {
  return ethers.utils
    .hexZeroPad(ethers.utils.hexStripZeros(address), 32)
    .toLowerCase();
}

export function bytes32ToAddress(bytes32: string): Address {
  return ethers.utils.getAddress(bytes32.slice(-40));
}

export const formatMessage = (
  localDomain: Domain,
  senderAddr: Address,
  sequence: number,
  destinationDomain: Domain,
  recipientAddr: Address,
  body: HexString
): string => {
  senderAddr = addressToBytes32(senderAddr);
  recipientAddr = addressToBytes32(recipientAddr);

  return ethers.utils.solidityPack(
    ["uint32", "bytes32", "uint32", "uint32", "bytes32", "bytes"],
    [localDomain, senderAddr, sequence, destinationDomain, recipientAddr, body]
  );
};

export function messageHash(message: HexString): string {
  return ethers.utils.solidityKeccak256(["bytes"], [message]);
}

export function destinationAndNonce(
  destination: Domain,
  sequence: number
): ethers.BigNumber {
  assert(destination < Math.pow(2, 32) - 1);
  assert(sequence < Math.pow(2, 32) - 1);

  return ethers.BigNumber.from(destination)
    .mul(ethers.BigNumber.from(2).pow(32))
    .add(ethers.BigNumber.from(sequence));
}

export function domainHash(domain: Number): string {
  return ethers.utils.solidityKeccak256(
    ["uint32", "string"],
    [domain, "OPTICS"]
  );
}
