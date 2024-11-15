import { Signer, Wallet } from 'ethers';

import { ChainSubmissionStrategy, TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ChainName } from '@hyperlane-xyz/sdk';

export interface IMultiChainSigner {
  getPrivateKey(chain: ChainName): Promise<string>;
  getSigner(privateKey: string): Signer;
  getType(): TxSubmitterType;
}

export abstract class BaseMultiChainSigner implements IMultiChainSigner {
  constructor(protected config: ChainSubmissionStrategy) {}

  abstract getPrivateKey(chain: ChainName): Promise<string>;

  getSigner(privateKey: string): Signer {
    return new Wallet(privateKey);
  }

  abstract getType(): TxSubmitterType;
}
