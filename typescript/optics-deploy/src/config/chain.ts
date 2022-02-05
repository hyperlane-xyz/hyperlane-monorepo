import * as ethers from 'ethers';
import { NonceManager } from '@ethersproject/experimental';

type Address = string;

export enum ChainName {
  // Mainnets
  CELO = 'celo',
  ETHEREUM = 'ethereum',
  AVALANCHE = 'avalanche',
  POLYGON = 'polygon',

  // Testnets
  ALFAJORES = 'alfajores',
  MUMBAI = 'mumbai',
  KOVAN = 'kovan',
  GORLI = 'gorli',
  FUJI = 'fuji',
  RINKARBY = 'rinkarby',
  RINKEBY = 'rinkeby',
  ROPSTEN = 'ropsten',
}

export type DomainedChain = {
  name: ChainName;
  domain: number;
}

export type ChainConfigJson = DomainedChain & {
  rpc: string;
  deployerKey?: string;
  gasLimit?: ethers.BigNumberish;
  gasPrice?: ethers.BigNumberish;
  confirmations?: number;
  maxFeePerGas?: ethers.BigNumberish;
  maxPriorityFeePerGas?: ethers.BigNumberish;
  weth?: Address;
}

export class ChainConfig {
  name: ChainName;
  domain: number;
  confirmations: number;
  provider: ethers.providers.JsonRpcProvider;
  signer: ethers.Signer;
  gasPrice: ethers.BigNumber;
  gasLimit: ethers.BigNumber;
  json: ChainConfigJson;
  maxFeePerGas?: ethers.BigNumber;
  maxPriorityFeePerGas?: ethers.BigNumber;
  weth?: Address;

  constructor(json: ChainConfigJson) {
    this.name = json.name;
    this.domain = json.domain;
    this.confirmations = json.confirmations ?? 5;
    this.json = json;

    this.provider = new ethers.providers.JsonRpcProvider(json.rpc);
    const wallet = new ethers.Wallet(json.deployerKey!, this.provider);
    this.signer = new NonceManager(wallet);
    this.gasPrice = ethers.BigNumber.from(json.gasPrice ?? '20000000000');
    this.gasLimit = ethers.BigNumber.from(json.gasLimit ?? 6_000_000);
    this.maxFeePerGas = json.maxFeePerGas
      ? ethers.BigNumber.from(json.maxFeePerGas)
      : undefined;
    this.maxPriorityFeePerGas = json.maxPriorityFeePerGas
      ? ethers.BigNumber.from(json.maxPriorityFeePerGas)
      : undefined;
    this.weth = json.weth;
  }

  replaceSigner(privateKey: string) {
    const wallet = new ethers.Wallet(privateKey, this.provider);
    this.signer = new NonceManager(wallet);
  }
}
