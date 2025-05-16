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
};

// see https://etherscan.io/contract-license-types
export enum ExplorerLicenseType {
  NO_LICENSE = '1',
  UNLICENSED = '2',
  MIT = '3',
  GPL2 = '4',
  GPL3 = '5',
  LGPL2 = '6',
  LGPL3 = '7',
  BSD2 = '8',
  BSD3 = '9',
  MPL2 = '10',
  OSL3 = '11',
  APACHE2 = '12',
  AGPL3 = '13',
  BSL = '14',
}

export type CompilerOptions = {
  codeformat: 'solidity-standard-json-input';
  compilerversion: string; // see https://etherscan.io/solcversions for list of support versions
  licenseType?: ExplorerLicenseType;
};

export enum ExplorerApiActions {
  GETSOURCECODE = 'getsourcecode',
  VERIFY_IMPLEMENTATION = 'verifysourcecode',
  VERIFY_PROXY = 'verifyproxycontract',
  CHECK_IMPLEMENTATION_STATUS = 'checkverifystatus',
  CHECK_PROXY_STATUS = 'checkproxyverification',
}

export const EXPLORER_GET_ACTIONS = [
  ExplorerApiActions.CHECK_IMPLEMENTATION_STATUS,
  ExplorerApiActions.CHECK_PROXY_STATUS,
  ExplorerApiActions.GETSOURCECODE,
];

export enum VerifyContractTypes {
  Proxy = 'proxy',
  ProxyAdmin = 'proxyAdmin',
  Implementation = 'implementation',
}

export enum ExplorerApiErrors {
  ALREADY_VERIFIED = 'Contract source code already verified',
  ALREADY_VERIFIED_ALT = 'Already Verified',
  NOT_VERIFIED = 'Contract source code not verified',
  VERIFICATION_PENDING = 'Pending in queue',
  PROXY_FAILED = 'A corresponding implementation contract was unfortunately not detected for the proxy address.',
  BYTECODE_MISMATCH = 'Fail - Unable to verify. Compiled contract deployment bytecode does NOT match the transaction deployment bytecode.',
  UNABLE_TO_VERIFY = 'Fail - Unable to verify',
  UNKNOWN_UID = 'Unknown UID',
}

export type FormOptions<Action extends ExplorerApiActions> =
  Action extends ExplorerApiActions.GETSOURCECODE
    ? {
        address: string;
      }
    : Action extends ExplorerApiActions.VERIFY_IMPLEMENTATION
      ? CompilerOptions & {
          contractaddress: string;
          sourceCode: string;
          contractname: string;
          /* TYPO IS ENFORCED BY API */
          constructorArguements?: string;
        }
      : Action extends ExplorerApiActions.VERIFY_PROXY
        ? {
            address: string;
            expectedimplementation: string;
          }
        : Action extends ExplorerApiActions.CHECK_IMPLEMENTATION_STATUS
          ? {
              guid: string;
            }
          : Action extends ExplorerApiActions.CHECK_PROXY_STATUS
            ? {
                guid: string;
              }
            : never;
