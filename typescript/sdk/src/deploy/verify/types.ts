export type ContractVerificationInput = {
  name: string;
  address: string;
  constructorArguments: string; // abi-encoded bytes
  isProxy?: boolean;
};

export type VerificationInput = ContractVerificationInput[];
