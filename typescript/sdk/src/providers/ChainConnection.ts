import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import { IChainConnection } from '../types';

export class ChainConnection {
  provider: ethers.providers.Provider;
  signer?: ethers.Signer;
  overrides: ethers.Overrides;
  confirmations: number;
  blockExplorerUrl: string;
  apiPrefix: string;
  logger: Debugger;

  constructor(dc: IChainConnection) {
    this.provider = dc.provider;
    this.signer = dc.signer;
    this.overrides = dc.overrides ?? {};
    this.confirmations = dc.confirmations ?? 0;
    this.blockExplorerUrl = dc.blockExplorerUrl ?? 'UNKNOWN_EXPLORER';
    this.apiPrefix = dc.apiPrefix ?? 'api-';
    this.logger = debug('hyperlane:ChainConnection');
  }

  getConnection = (): ethers.providers.Provider | ethers.Signer =>
    this.signer ?? this.provider;

  getAddress = (): Promise<string> | undefined => this.signer?.getAddress();

  getTxUrl(response: ethers.providers.TransactionResponse): string {
    return `${this.blockExplorerUrl}/tx/${response.hash}`;
  }

  async getAddressUrl(address?: string): Promise<string> {
    return `${this.blockExplorerUrl}/address/${
      address ?? (await this.signer!.getAddress())
    }`;
  }

  getApiUrl(): string {
    const prefix = 'https://';
    return `${prefix}${this.apiPrefix}${this.blockExplorerUrl.slice(
      prefix.length,
    )}/api`;
  }

  async handleTx(
    tx: ethers.ContractTransaction | Promise<ethers.ContractTransaction>,
  ): Promise<ethers.ContractReceipt> {
    const response = await tx;
    this.logger(
      `Pending ${this.getTxUrl(response)} (waiting ${
        this.confirmations
      } blocks for confirmation)`,
    );
    return response.wait(this.confirmations);
  }

  async estimateGas(
    tx: ethers.PopulatedTransaction,
    from?: string,
  ): Promise<ethers.BigNumber> {
    let txFrom = from;
    if (!txFrom) {
      txFrom = await this.getAddress();
    }
    return this.provider.estimateGas({
      ...tx,
      from: txFrom,
      ...this.overrides,
    });
  }

  async sendTransaction(
    tx: ethers.PopulatedTransaction,
  ): Promise<ethers.ContractReceipt> {
    if (!this.signer) throw new Error('no signer found');
    const from = await this.signer.getAddress();
    const response = await this.signer.sendTransaction({
      ...tx,
      from,
      ...this.overrides,
    });
    this.logger(`sent tx ${response.hash}`);
    return this.handleTx(response);
  }
}
