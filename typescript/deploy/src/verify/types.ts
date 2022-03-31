export type ContractVerificationInput = {
  name: string;
  address: string;
  constructorArguments: any[];
  isProxy?: boolean;
};

export type VerificationInput = ContractVerificationInput[];
