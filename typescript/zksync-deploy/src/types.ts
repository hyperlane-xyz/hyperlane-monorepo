export type DeploymentList = {
  [key: string]: string;
};
// An alias for string to clarify type is a chain name
export type ChainName = string;
// A map of chain names to a value type
export type ChainMap<Value> = Record<string, Value>;
export type Address = string;

export enum ProtocolType {
  Ethereum = 'ethereum',
  Sealevel = 'sealevel',
  Fuel = 'fuel',
  Cosmos = 'cosmos',
}

export type DeployContractOptions = {
  /**
   * If true, the deployment process will not print any logs
   */
  silent?: boolean;
  /**
   * If true, the contract will not be verified on Block Explorer
   */
  noVerify?: boolean;
  /**
   * If specified, the contract will be deployed using this wallet
   */
  wallet?: Wallet;
};
