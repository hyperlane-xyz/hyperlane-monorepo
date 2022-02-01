import { Network } from './chain';
type Address = string;

export type ProxyAddresses = {
  implementation: Address;
  proxy: Address;
  beacon: Address;
};

type DomainedAddress = {
  domain: number;
  address: Address;
  _proxy?: ProxyAddresses;
}

export type CoreContractAddresses = {
  upgradeBeaconController: Address;
  xAppConnectionManager: Address;
  updaterManager: Address;
  governanceRouter: ProxyAddresses;
  home: DomainedAddress;
  replicas?: Record<Network, DomainedAddress>;
};

export type BridgeContractAddresses = {
  bridgeRouter: ProxyAddresses;
  bridgeToken: ProxyAddresses;
  ethHelper?: Address;
};

