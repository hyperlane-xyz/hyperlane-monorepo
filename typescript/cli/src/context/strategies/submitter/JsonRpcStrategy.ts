import { password } from '@inquirer/prompts';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ChainName } from '@hyperlane-xyz/sdk';

import { BaseSubmitterStrategy } from './SubmitterStrategy.js';

export class JsonRpcStrategy extends BaseSubmitterStrategy {
  async getPrivateKey(chain: ChainName): Promise<string> {
    let pk = this.config[chain]?.submitter?.privateKey;

    if (!pk) {
      pk = await password({
        message: `Please enter the private key for chain ${chain}`,
      });
    }

    return pk;
  }

  getType(): TxSubmitterType {
    return TxSubmitterType.JSON_RPC;
  }
}
