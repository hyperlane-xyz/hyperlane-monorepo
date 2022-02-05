import { ethers } from 'ethers';
import { ChainConfig } from './config/chain';
import { Contracts } from './contracts';
import path from 'path';

export type DeployEnvironment =
  | 'dev'
  | 'testnet'
  | 'mainnet'
  | 'testnet-legacy'
  | 'mainnet-legacy'
  | 'test';

type XAppConnectionName = 'XAppConnectionManager';
type UpdaterManagerName = 'UpdaterManager';
type UBCName = 'UpgradeBeaconController';
type HomeName = 'Home UpgradeBeacon' | 'Home Proxy' | 'Home Implementation';
type ReplicaName =
  | 'Replica UpgradeBeacon'
  | 'Replica Proxy'
  | 'Replica Implementation';
type GovernanceName =
  | 'Governance UpgradeBeacon'
  | 'Governance Proxy'
  | 'Governance Implementation';
type EthHelperName = 'ETH Helper';
type BridgeTokenName =
  | 'BridgeToken UpgradeBeacon'
  | 'BridgeToken Proxy'
  | 'BridgeToken Implementation';
type BridgeRouterName =
  | 'BridgeRouter UpgradeBeacon'
  | 'BridgeRouter Proxy'
  | 'BridgeRouter Implementation';

export type ContractVerificationName =
  | XAppConnectionName
  | UpdaterManagerName
  | UBCName
  | HomeName
  | ReplicaName
  | GovernanceName
  | EthHelperName
  | BridgeTokenName
  | BridgeRouterName;

export type ContractVerificationInput = {
  name: ContractVerificationName;
  address: string;
  constructorArguments: any[];
  isProxy?: boolean;
};

export abstract class Deploy<T extends Contracts> {
  readonly chainConfig: ChainConfig;
  readonly test: boolean;
  readonly environment: DeployEnvironment;
  contracts: T;
  verificationInput: ContractVerificationInput[];

  abstract get ubcAddress(): string | undefined;

  constructor(chainConfig: ChainConfig, contracts: T, environment: DeployEnvironment, test: boolean = false) {
    this.chainConfig = chainConfig;
    this.verificationInput = [];
    this.test = test;
    this.contracts = contracts;
    this.environment = environment;
  }

  get signer(): ethers.Signer {
    return this.chainConfig.signer;
  }

  async ready(): Promise<ethers.providers.Network> {
    return await this.provider.ready;
  }

  get provider(): ethers.providers.JsonRpcProvider {
    return this.chainConfig.provider;
  }

  get supports1559(): boolean {
    let notSupported = ['kovan', 'alfajores', 'baklava', 'celo', 'polygon'];
    return notSupported.indexOf(this.chainConfig.name) === -1;
  }

  get configPath(): string {
    return path.join('../../../config/environments', this.environment)
  }

  // this is currently a kludge to account for ethers issues
  get overrides(): ethers.Overrides {
    let overrides: ethers.Overrides;

    if (this.supports1559) {
      overrides = {
        maxFeePerGas: this.chainConfig.maxFeePerGas,
        maxPriorityFeePerGas: this.chainConfig.maxPriorityFeePerGas,
        gasLimit: this.chainConfig.gasLimit,
      };
    } else {
      overrides = {
        type: 0,
        gasPrice: this.chainConfig.gasPrice,
        gasLimit: this.chainConfig.gasLimit,
      };
    }

    return overrides;
  }
}
