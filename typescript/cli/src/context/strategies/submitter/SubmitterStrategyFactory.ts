import { ChainSubmissionStrategy, TxSubmitterType } from '@hyperlane-xyz/sdk';

import { JsonRpcStrategy } from './JsonRpcStrategy.js';
import { ISubmitterStrategy } from './SubmitterStrategy.js';

export class SubmitterStrategyFactory {
  static createStrategy(
    type: TxSubmitterType,
    config: ChainSubmissionStrategy,
  ): ISubmitterStrategy {
    switch (type) {
      case TxSubmitterType.JSON_RPC:
        return new JsonRpcStrategy(config);
      // TO BE IMPLEMENTED!
      // case TxSubmitterType.STARKNET_JSON_RPC:
      //   return new StarknetJsonRpcStrategy(config);
      default:
        throw new Error(`Unsupported submitter type: ${type}`);
    }
  }
}
