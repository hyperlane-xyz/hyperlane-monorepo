import { Domain } from '../../domains';
import { Address } from '../../utils';

export interface AbacusDomain extends Domain {
  bridgeRouter: Address;
  ethHelper?: Address;
  outbox: Address;
  inboxs: InboxInfo[];
  governanceRouter: Address;
  xAppConnectionManager: Address;
}

export interface InboxInfo {
  domain: number;
  address: Address;
}
