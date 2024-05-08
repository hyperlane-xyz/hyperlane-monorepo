import { ProtocolType } from '@hyperlane-xyz/utils';

import { TxTransformerInterface } from '../TxTransformerInterface.js';

export interface EV5TxTransformerInterface
  extends TxTransformerInterface<ProtocolType.Ethereum> {}
