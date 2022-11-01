import { HyperlaneApp } from '../../HyperlaneApp';
import { TokenBridgeContracts } from '../../tokenBridge';
import { ChainName } from '../../types';

export class TokenBridgeApp<
  Chain extends ChainName = ChainName,
> extends HyperlaneApp<TokenBridgeContracts, Chain> {}
