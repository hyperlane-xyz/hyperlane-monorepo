import { ethers } from 'ethers';

import { IChainConnection } from '../types';

export class ChainConnection {
  provider: ethers.providers.Provider;
  signer?: ethers.Signer;
  overrides: ethers.Overrides;
  confirmations: number;
  blockExplorerUrl?: string;

  constructor(dc: IChainConnection) {
    this.provider = dc.provider;
    this.signer = dc.signer;
    this.overrides = dc.overrides ?? {};
    this.confirmations = dc.confirmations ?? 0;
    this.blockExplorerUrl = dc.blockExplorerUrl ?? 'UNKNOWN_EXPLORER';
  }

  getConnection = (): ethers.providers.Provider | ethers.Signer =>
    this.signer ?? this.provider;

  getAddress = (): Promise<string> | undefined => this.signer?.getAddress();

  getTxUrl(response: ethers.providers.TransactionResponse): string {
    return `${this.blockExplorerUrl}/tx/${response.hash}`;
  }

  async getAddressUrl(): Promise<string> {
    return `${
      this.blockExplorerUrl
    }/address/${await this.signer!.getAddress()}`;
  }
}
