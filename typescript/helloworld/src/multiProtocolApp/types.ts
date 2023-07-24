import { ChainName, IRouterAdapter } from '@hyperlane-xyz/sdk';

import { StatCounts } from '../app/types';

export interface IHelloWorldAdapter extends IRouterAdapter {
  populateHelloWorldTx: (
    from: ChainName,
    to: ChainName,
    message: string,
    value: string,
  ) => Promise<any>; //TODO

  channelStats: (from: ChainName, to: ChainName) => Promise<StatCounts>;
}
