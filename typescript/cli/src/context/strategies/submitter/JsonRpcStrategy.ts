import { password } from '@inquirer/prompts';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ChainName } from '@hyperlane-xyz/sdk';

import { BaseSubmitterStrategy } from './SubmitterStrategy.js';

export class JsonRpcStrategy extends BaseSubmitterStrategy {
  async getPrivateKey(chain: ChainName): Promise<string> {
    const submitter = this.config[chain]?.submitter as {
      type: TxSubmitterType.JSON_RPC;
      privateKey?: string;
    };

    return (
      submitter?.privateKey ??
      (await password({
        message: `Please enter the private key for chain ${chain}`,
      }))
    );
  }

  getType(): TxSubmitterType {
    return TxSubmitterType.JSON_RPC;
  }
}
