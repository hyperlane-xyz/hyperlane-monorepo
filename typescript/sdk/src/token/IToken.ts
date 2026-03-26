import type { Address } from '@hyperlane-xyz/utils';

import type { MultiProviderAdapter } from '../providers/MultiProviderAdapter.js';
import type { ChainName } from '../types.js';

import type { TokenAmount } from './TokenAmount.js';
import type { ITokenMetadata } from './ITokenMetadata.js';
import type { TokenConnection } from './TokenConnection.js';
import type {
  IHypTokenAdapter,
  ITokenAdapter,
} from './adapters/ITokenAdapter.js';
export type { ITokenMetadata, TokenArgs } from './ITokenMetadata.js';
export { TokenConfigSchema } from './ITokenMetadata.js';

export interface IToken extends ITokenMetadata {
  getConnections(): TokenConnection<IToken>[];
  getConnectionForChain(chain: ChainName): TokenConnection<IToken> | undefined;
  addConnection(connection: TokenConnection<IToken>): IToken;
  removeConnection(token: IToken): IToken;

  getAdapter(multiProvider: MultiProviderAdapter): ITokenAdapter<unknown>;
  getHypAdapter(
    multiProvider: MultiProviderAdapter<{ mailbox?: Address }>,
    destination?: ChainName,
  ): IHypTokenAdapter<unknown>;

  getBalance(
    multiProvider: MultiProviderAdapter,
    address: Address,
  ): Promise<TokenAmount<IToken>>;
}
