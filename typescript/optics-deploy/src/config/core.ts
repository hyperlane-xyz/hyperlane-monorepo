type Address = string;

type Governor = {
  domain: number;
  address: Address;
};

export type EnvironmentName =
  | 'dev'
  | 'staging'
  | 'prod'
  | 'staging-community'
  | 'prod-community';

type CoreConfigAddresses = {
  updater: Address;
  watchers: Address[];
  recoveryManager: Address;
  governor: Governor;
}

export type CoreConfig = {
  environment: DeployEnvironment;
  recoveryTimelock: number;
  optimisticSeconds: number;
  processGas: BigNumberish;
  reserveGas: BigNumberish;
  addresses: CoreAddresses;
};
