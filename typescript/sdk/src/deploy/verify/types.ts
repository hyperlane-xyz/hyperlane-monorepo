export type ContractVerificationInput = {
  name: string;
  address: string;
  constructorArguments?: string; // abi-encoded bytes
  isProxy?: boolean;
};

export type VerificationInput = ContractVerificationInput[];

export type CompilerOptions = {
  codeformat: 'solidity-standard-json-input';
  compilerversion: string; // see https://etherscan.io/solcversions for list of support versions, inferred from build artifact
  licenseType:
    | '1'
    | '2'
    | '3'
    | '4'
    | '5'
    | '6'
    | '7'
    | '8'
    | '9'
    | '10'
    | '11'
    | '12'
    | '13'
    | '14'; // integer from 1-14, see https://etherscan.io/contract-license-types
};
