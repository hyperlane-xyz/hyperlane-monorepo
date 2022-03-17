import { BytesLike } from 'ethers';
import { BridgeToken } from '@abacus-network/apps';
import wellKnown from './wellKnown';
import testnetWellKnown from './testnetWellKnown';

export interface TokenIdentifier {
  domain: string | number;
  id: BytesLike;
}

export type ResolvedTokenInfo = {
  // The canonical domain
  domain: number;
  // The canonical identifier
  id: BytesLike;
  // The contract on each chain
  tokens: Map<number, BridgeToken>;
};

export const tokens = wellKnown;
export const testnetTokens = testnetWellKnown;
