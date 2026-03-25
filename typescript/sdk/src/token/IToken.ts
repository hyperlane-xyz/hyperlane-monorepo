import type { Address } from '@hyperlane-xyz/utils';

import type { ConfiguredMultiProtocolProvider as MultiProtocolProvider } from '../providers/ConfiguredMultiProtocolProvider.js';
import type { ChainName } from '../types.js';

import type { TokenAmount } from './TokenAmount.js';
import type { ITokenMetadata } from './ITokenMetadata.js';
import type { TokenConnection } from './TokenConnection.js';
import type {
  IHypTokenAdapter,
  ITokenAdapter,
} from './adapters/ITokenAdapter.js';
export {
  type ITokenMetadata,
  TokenArgs,
  TokenConfigSchema,
} from './ITokenMetadata.js';

export interface IToken extends ITokenMetadata {
  getConnections(): TokenConnection<IToken>[];
  getConnectionForChain(chain: ChainName): TokenConnection<IToken> | undefined;
  addConnection(connection: TokenConnection<IToken>): IToken;
  removeConnection(token: IToken): IToken;

  getAdapter(multiProvider: MultiProtocolProvider): ITokenAdapter<unknown>;
  getHypAdapter(
    multiProvider: MultiProtocolProvider<{ mailbox?: Address }>,
    destination?: ChainName,
  ): IHypTokenAdapter<unknown>;

  getBalance(
    multiProvider: MultiProtocolProvider,
    address: Address,
  ): Promise<TokenAmount<IToken>>;
}
