import {
  ChainName,
  IRouterAdapter,
  TypedTransaction,
} from '@hyperlane-xyz/sdk';

import { StatCounts } from '../app/types';

export interface IHelloWorldAdapter extends IRouterAdapter {
  populateHelloWorldTx: (
    from: ChainName,
    to: ChainName,
    message: string,
    value: string,
  ) => Promise<TypedTransaction>;

  channelStats: (from: ChainName, to: ChainName) => Promise<StatCounts>;
}
