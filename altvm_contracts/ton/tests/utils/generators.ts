import { randomBytes } from 'crypto';

export const makeRandomBigint = () => BigInt('0x' + randomBytes(32).toString('hex'));
export const makeRandomId = (bits: number) => Math.floor(Math.random() * Math.pow(2, bits) - 1);
