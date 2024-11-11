import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ChainName } from '@hyperlane-xyz/sdk';

import { BaseSubmitterStrategy } from './SubmitterStrategy.js';

export class GnosisSafeStrategy extends BaseSubmitterStrategy {
  async getPrivateKey(chain: ChainName): Promise<string> {
    // Future works: Implement Gnosis Safe specific logic
    throw new Error('Not implemented');
  }

  getType(): TxSubmitterType {
    return TxSubmitterType.GNOSIS_SAFE;
  }
}
