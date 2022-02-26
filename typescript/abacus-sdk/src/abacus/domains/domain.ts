import { Domain } from '../../domains';
import { Address } from '../../utils';

export interface AbacusDomain extends Domain {
  bridgeRouter: Address;
  ethHelper?: Address;
  home: Address;
  replicas: ReplicaInfo[];
  governanceRouter: Address;
  xAppConnectionManager: Address;
}

export interface ReplicaInfo {
  domain: number;
  address: Address;
}
