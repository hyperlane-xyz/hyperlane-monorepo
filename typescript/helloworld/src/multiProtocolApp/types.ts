import {
  type ChainName,
  type IRouterAdapter,
  type TypedTransaction,
} from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

export interface IHelloWorldAdapter extends IRouterAdapter {
  populateSendHelloTx: (
    destination: ChainName,
    message: string,
    value: string,
    sender: Address,
  ) => Promise<TypedTransaction>;

  sentStat: (destination: ChainName) => Promise<number>;
}
