import type { ExplorerLicenseType } from '../../block-explorer/etherscan.js';

export type ContractVerificationInput = {
  name: string;
  address: string;
  constructorArguments?: string; // abi-encoded bytes
  isProxy?: boolean;
  expectedimplementation?: string;
};

export type VerificationInput = ContractVerificationInput[];

export type SolidityStandardJsonInput = {
  sources: {
    [sourceName: string]: {
      content: string;
    };
  };
  language: string;
  settings: {
    optimizer: {
      enabled: boolean;
      runs: number;
    };
    outputSelection: any;
  };
};

export type BuildArtifact = {
  input: SolidityStandardJsonInput;
  solcLongVersion: string;
  zk_version?: string; //only for zksync
};

export type CompilerOptions = {
  codeformat: 'solidity-standard-json-input';
  compilerversion: string; // see https://etherscan.io/solcversions for list of support versions
  licenseType?: ExplorerLicenseType;
  zksolcversion?: string; //only for zksync chains
};

export type ZKSyncCompilerOptions = {
  codeFormat: 'solidity-standard-json-input';
  compilerSolcVersion: string;
  compilerZksolcVersion: string;
  optimizationUsed: boolean;
};

export enum VerifyContractTypes {
  Proxy = 'proxy',
  ProxyAdmin = 'proxyAdmin',
  Implementation = 'implementation',
}
