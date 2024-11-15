import { ChainSubmissionStrategy, TxSubmitterType } from '@hyperlane-xyz/sdk';

import { IMultiChainSigner } from './BaseMultiChainSigner.js';
import { JsonRpcSigner } from './JsonRpcSigner.js';

export class MultiChainSignerFactory {
  static getSignerStrategy(
    type: TxSubmitterType,
    config: ChainSubmissionStrategy,
  ): IMultiChainSigner {
    switch (type) {
      case TxSubmitterType.JSON_RPC:
        return new JsonRpcSigner(config);
      // Future works: TO BE IMPLEMENTED!
      default:
        throw new Error(`Unsupported submitter type: ${type}`);
    }
  }
}
