type XAppConnectionName = 'XAppConnectionManager';
type ValidatorManagerName = 'ValidatorManager';
type UBCName = 'UpgradeBeaconController';
type OutboxName =
  | 'Outbox UpgradeBeacon'
  | 'Outbox Proxy'
  | 'Outbox Implementation';
type InboxName = 'Inbox UpgradeBeacon' | 'Inbox Proxy' | 'Inbox Implementation';
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
  | ValidatorManagerName
  | UBCName
  | OutboxName
  | InboxName
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

export type VerificationInput = ContractVerificationInput[];
