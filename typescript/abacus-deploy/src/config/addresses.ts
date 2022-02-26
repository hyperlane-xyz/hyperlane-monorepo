type Address = string;

export type ProxiedAddress = {
  proxy: Address;
  implementation: Address;
  beacon: Address;
};

export type CoreContractAddresses = {
  upgradeBeaconController: Address;
  xAppConnectionManager: Address;
  updaterManager: Address;
  governanceRouter: ProxiedAddress;
  home: ProxiedAddress;
  // TODO: Put chain name in here
  replicas?: Record<number, ProxiedAddress>;
};

export type BridgeContractAddresses = {
  bridgeRouter: ProxiedAddress;
  bridgeToken: ProxiedAddress;
  ethHelper?: Address;
};

export type CoreConfigAddresses = {
  updater: Address;
  watchers: Address[];
  recoveryManager: Address;
  governor?: Address;
};

export type CoreDeployAddresses = CoreContractAddresses & CoreConfigAddresses;
