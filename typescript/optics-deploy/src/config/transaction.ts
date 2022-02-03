import * as ethers from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import { NetworkName } from './domain';

export type TransactionConfigJson {
  name: NetworkName;
  rpc: string;
  deployerKey?: string;
  gasLimit?: ethers.BigNumberish;
  gasPrice?: ethers.BigNumberish;
  confirmations?: number;
  maxFeePerGas?: ethers.BigNumberish;
  maxPriorityFeePerGas?: ethers.BigNumberish;
}

export class TransactionConfig {
  name: NetworkName;
  domain: number;
  confirmations: number;
  provider: ethers.providers.JsonRpcProvider;
  signer: ethers.Signer;
  gasPrice: ethers.BigNumber;
  gasLimit: ethers.BigNumber;
  json: json;
  maxFeePerGas?: ethers.BigNumber;
  maxPriorityFeePerGas?: ethers.BigNumber;

  constructor(json: TransactionConfigJson) {
    this.name = json.name;
    this.domain = json.domain;
    this.confirmations = json.confirmations ?? 5;

    this.provider = new ethers.providers.JsonRpcProvider(json.rpc);
    const wallet = new ethers.Wallet(json.deployerKey!, this.provider);
    this.signer = new NonceManager(wallet);
    this.gasPrice = ethers.BigNumber.from(json.gasPrice ?? '20000000000');
    this.gasLimit = ethers.BigNumber.from(json.gasLimit ?? 6_000_000);
    this.
    this.maxFeePerGas = json.maxFeePerGas
      ? ethers.BigNumber.from(json.maxFeePerGas)
      : undefined;
    this.maxPriorityFeePerGas = json.maxPriorityFeePerGas
      ? ethers.BigNumber.from(json.maxPriorityFeePerGas)
      : undefined;
  }

  replaceSigner(privateKey: string) {
    const wallet = new ethers.Wallet(privateKey, this.provider);
    this.signer = new NonceManager(wallet);
  }
}
