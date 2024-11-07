import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { GnosisSafeStrategy } from './GnosisSafeStrategy.js';
import { JsonRpcStrategy } from './JsonRpcStrategy.js';
import { ISubmitterStrategy } from './SubmitterStrategy.js';

export class SubmitterStrategyFactory {
  static createStrategy(
    type: TxSubmitterType,
    config: any,
  ): ISubmitterStrategy {
    switch (type) {
      case TxSubmitterType.JSON_RPC:
        return new JsonRpcStrategy(config);
      case TxSubmitterType.GNOSIS_SAFE:
        return new GnosisSafeStrategy(config);
      default:
        throw new Error(`Unsupported submitter type: ${type}`);
    }
  }
}
