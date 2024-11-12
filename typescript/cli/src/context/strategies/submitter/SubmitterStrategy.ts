import { ethers } from 'ethers';

import { ChainSubmissionStrategy, TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ChainName } from '@hyperlane-xyz/sdk';

export interface ISubmitterStrategy {
  getPrivateKey(chain: ChainName): Promise<string>;
  getSigner(privateKey: string): ethers.Signer;
  getType(): TxSubmitterType;
}

export abstract class BaseSubmitterStrategy implements ISubmitterStrategy {
  constructor(protected config: ChainSubmissionStrategy) {}

  abstract getPrivateKey(chain: ChainName): Promise<string>;

  getSigner(privateKey: string): ethers.Signer {
    return new ethers.Wallet(privateKey);
  }

  abstract getType(): TxSubmitterType;
}
