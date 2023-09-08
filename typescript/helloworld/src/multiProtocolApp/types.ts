import {
  ChainName,
  IRouterAdapter,
  TypedTransaction,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { StatCounts } from '../app/types';

export interface IHelloWorldAdapter extends IRouterAdapter {
  populateSendHelloTx: (
    destination: ChainName,
    message: string,
    value: string,
    sender: Address,
  ) => Promise<TypedTransaction>;

  channelStats: (
    destination: ChainName,
    destinationMailbox: Address,
  ) => Promise<StatCounts>;
}
