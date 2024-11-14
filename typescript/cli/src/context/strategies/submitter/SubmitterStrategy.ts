import { Signer, Wallet } from 'ethers';

import { ChainSubmissionStrategy, TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ChainName } from '@hyperlane-xyz/sdk';

export interface ISubmitterStrategy {
  getPrivateKey(chain: ChainName): Promise<string>;
  getSigner(privateKey: string): Signer;
  getType(): TxSubmitterType;
}

export abstract class BaseSubmitterStrategy implements ISubmitterStrategy {
  constructor(protected config: ChainSubmissionStrategy) {}

  abstract getPrivateKey(chain: ChainName): Promise<string>;

  getSigner(privateKey: string): Signer {
    return new Wallet(privateKey);
  }

  abstract getType(): TxSubmitterType;
}
