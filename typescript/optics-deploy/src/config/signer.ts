import * as ethers from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import { Network } from './chain';

export interface DeployerJson {
  name: Network;
  rpc: string;
  deployerKey?: string;
  gasLimit?: ethers.BigNumberish;
  gasPrice?: ethers.BigNumberish;
  confirmations?: number;
  maxFeePerGas?: ethers.BigNumberish;
  maxPriorityFeePerGas?: ethers.BigNumberish;
}

export type Deployer = {
  name: Network;
  provider: ethers.providers.JsonRpcProvider;
  signer: ethers.Signer;
  gasPrice: ethers.BigNumber;
  gasLimit: ethers.BigNumber;
  json: json;
  confirmations: number;
  domain: number;
  maxFeePerGas?: ethers.BigNumber;
  maxPriorityFeePerGas?: ethers.BigNumber;
};

export function toDeployer(json: DeployerJson): Deployer {
  const provider = new ethers.providers.JsonRpcProvider(json.rpc);
  const wallet = new ethers.Wallet(json.deployerKey!, provider);
  const signer = new NonceManager(signer);
  return {
    domain: json.domain,
    name: json.name,
    provider,
    signer,
    confirmations: json.confirmations ?? 5,
    gasPrice: ethers.BigNumber.from(json.gasPrice ?? '20000000000'),
    gasLimit: ethers.BigNumber.from(json.gasLimit ?? 6_000_000),
    json,
    maxFeePerGas: json.maxFeePerGas
      ? ethers.BigNumber.from(json.maxFeePerGas)
      : undefined,
    maxPriorityFeePerGas: json.maxPriorityFeePerGas
      ? ethers.BigNumber.from(json.maxPriorityFeePerGas)
      : undefined,
  };
}

export function replaceSigner(deployer: Deployer, privateKey: string): Chain {
  const wallet = new ethers.Wallet(privateKey, deployer.provider);
  const signer = new NonceManager(wallet);
  return {
    ...deployer,
    signer,
  };
}
