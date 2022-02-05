import { DomainConfig } from './domain';
type Address = string;

export type ProxiedAddress = {
  address: Address;
  _implementation: Address;
  _beacon: Address;
};

type DomainedProxiedAddress = ProxiedAddress & DomainConfig;

export type CoreContractAddresses = {
  upgradeBeaconController: Address;
  xAppConnectionManager: Address;
  updaterManager: Address;
  governanceRouter: ProxiedAddress;
  home: DomainedProxiedAddress;
  replicas?: Record<Network, DomainedProxiedAddress>;
};

export type BridgeContractAddresses = {
  bridgeRouter: ProxiedAddress;
  bridgeToken: ProxiedAddress;
  ethHelper?: ProxiedAddress;
};
