import { utils } from 'ethers';

export function base58ToBuffer(value: string) {
  return Buffer.from(utils.base58.decode(value));
}

export function bufferToBase58(value: Buffer) {
  return utils.base58.encode(value);
}
