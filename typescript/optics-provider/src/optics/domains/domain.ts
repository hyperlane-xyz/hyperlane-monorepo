import { Domain } from '../../domains';
import { Address } from '../../utils';

export interface OpticsDomain extends Domain {
  bridgeRouter: Address;
  ethHelper?: Address;
  home: Address;
  replicas: ReplicaInfo[];
  governanceRouter: Address;
}

export interface ReplicaInfo {
  domain: number;
  address: Address;
}
