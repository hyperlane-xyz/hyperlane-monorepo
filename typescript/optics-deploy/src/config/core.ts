import { ChainName, DomainedChain } from './chain';
type Address = string;

type Governor = DomainedChain & {
  address: Address;
};

type ChainAddresses = {
  updater: Address;
  watchers: Address[];
  recoveryManager: Address;
}

type CoreConfigAddresses = {
  [chain: ChainName]: ChainAddresses;
  governor: Governor;
}

export type CoreConfig = {
  environment: DeployEnvironment;
  recoveryTimelock: number;
  optimisticSeconds: number;
  processGas: BigNumberish;
  reserveGas: BigNumberish;
  addresses: CoreConfigAddresses;
};
