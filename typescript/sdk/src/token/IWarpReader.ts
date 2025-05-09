import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { IHookReader } from '../hook/IHookReader.js';
import { IIsmReader } from '../ism/IIsmReader.js';

import { DerivedTokenRouterConfig } from './types.js';

export interface IWarpRouteReader<TProtocol extends ProtocolType> {
  protocol: TProtocol;

  hookReader?: IHookReader<TProtocol>;

  ismReader: IIsmReader<TProtocol>;

  deriveWarpRouteConfig(address: Address): Promise<DerivedTokenRouterConfig>;
}
