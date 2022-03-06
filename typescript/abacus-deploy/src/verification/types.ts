type XAppConnectionName = 'XAppConnectionManager';
type ValidatorManagerName = 'ValidatorManager';
type UBCName = 'UpgradeBeaconController';
type EthHelperName = 'ETH Helper';
export type BeaconProxyPrefix =
  | 'Outbox'
  | 'Inbox'
  | 'Governance'
  | 'BridgeToken'
  | 'BridgeRouter';
type BeaconProxySuffix = 'Implementation' | 'UpgradeBeacon' | 'Proxy';
type BeaconProxyName = `${BeaconProxyPrefix} ${BeaconProxySuffix}`;

export type ContractVerificationName =
  | XAppConnectionName
  | ValidatorManagerName
  | UBCName
  | EthHelperName
  | BeaconProxyName;

export type ContractVerificationInput = {
  name: ContractVerificationName;
  address: string;
  constructorArguments: any[];
  isProxy?: boolean;
};

export type VerificationInput = ContractVerificationInput[];
