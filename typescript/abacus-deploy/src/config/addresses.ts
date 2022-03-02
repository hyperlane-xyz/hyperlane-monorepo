type Address = string;

export type ProxiedAddress = {
  proxy: Address;
  implementation: Address;
  beacon: Address;
};

export type CoreContractAddresses = {
  upgradeBeaconController: Address;
  xAppConnectionManager: Address;
  validatorManager: Address;
  governanceRouter: ProxiedAddress;
  outbox: ProxiedAddress;
  // TODO: Put chain name in here
  inboxs?: Record<number, ProxiedAddress>;
};

export type BridgeContractAddresses = {
  bridgeRouter: ProxiedAddress;
  bridgeToken: ProxiedAddress;
  ethHelper?: Address;
};

export type CoreConfigAddresses = {
  validator: Address;
  recoveryManager: Address;
  governor?: Address;
};

export type CoreDeployAddresses = CoreContractAddresses & CoreConfigAddresses;
