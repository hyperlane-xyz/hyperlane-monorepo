import { password } from '@inquirer/prompts';

import { ChainName, TxSubmitterType } from '@hyperlane-xyz/sdk';

import { BaseMultiChainSigner } from './BaseMultiChainSigner.js';

export class JsonRpcSigner extends BaseMultiChainSigner {
  async getPrivateKey(chain: ChainName): Promise<string> {
    const submitter = this.config[chain]?.submitter as {
      type: TxSubmitterType.JSON_RPC;
      privateKey?: string;
    };

    const privateKey =
      submitter?.privateKey ??
      (await password({
        message: `Please enter the private key for chain ${chain}`,
      }));

    return privateKey;
  }

  getType(): TxSubmitterType {
    return TxSubmitterType.JSON_RPC;
  }
}
