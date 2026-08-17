import {
  Address,
  HexString,
  assert,
  isNullish,
  pick,
  retryAsync,
  strip0x,
} from '@hyperlane-xyz/utils';

import type { SolidityStandardJsonInput } from '../deploy/verify/types.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';
import { toNumber } from '../utils/numbers.js';

export enum EtherscanLikeExplorerApiModule {
  LOGS = 'logs',
  CONTRACT = 'contract',
}

export enum EtherscanLikeExplorerApiAction {
  GETSOURCECODE = 'getsourcecode',
  VERIFY_IMPLEMENTATION = 'verifysourcecode',
  VERIFY_PROXY = 'verifyproxycontract',
  CHECK_IMPLEMENTATION_STATUS = 'checkverifystatus',
  CHECK_PROXY_STATUS = 'checkproxyverification',
  GET_CONTRACT_CREATION_CODE = 'getcontractcreation',
  GET_LOGS = 'getLogs',
}

export enum EtherscanLikeExplorerApiErrors {
  ALREADY_VERIFIED = 'Contract source code already verified',
  ALREADY_VERIFIED_ALT = 'Already Verified',
  NOT_VERIFIED = 'Contract source code not verified',
  VERIFICATION_PENDING = 'Pending in queue',
  PROXY_FAILED = 'A corresponding implementation contract was unfortunately not detected for the proxy address.',
  BYTECODE_MISMATCH = 'Fail - Unable to verify. Compiled contract deployment bytecode does NOT match the transaction deployment bytecode.',
  UNABLE_TO_VERIFY = 'Fail - Unable to verify',
  UNKNOWN_UID = 'Unknown UID',
  NO_RECORD = 'No records found',
  NO_LOGS_FOUND = 'No logs found',
}

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

interface EtherscanLikeAPIOptions {
  // Explorers like Blockscout don't require an API key for requests
  apiKey?: string;
  apiUrl: string;
}

interface BaseEtherscanLikeAPIParams<
  TModule extends EtherscanLikeExplorerApiModule,
  TAction extends EtherscanLikeExplorerApiAction,
> {
  module: TModule;
  action: TAction;
}

function formatExplorerUrl<
  TModule extends EtherscanLikeExplorerApiModule,
  TAction extends EtherscanLikeExplorerApiAction,
>(
  { apiUrl, apiKey }: EtherscanLikeAPIOptions,
  params: BaseEtherscanLikeAPIParams<TModule, TAction>,
): string {
  // hack for Blockscout API urls that in the explorer have the `eth-rpc` path set
  // as it will cause requests to fail with a not found error
  const urlObject = new URL(apiUrl.replace('eth-rpc', ''));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      urlObject.searchParams.append(key, value.toString());
    }
  }

  if (apiKey) {
    urlObject.searchParams.append('apikey', apiKey);
  }

  return urlObject.toString();
}

async function handleEtherscanResponse<T>(response: Response): Promise<T> {
  const body = await response.json();

  const explorerUrl = new URL(response.url);
  // Avoid throwing if no logs are found for the current address
  if (
    body.status === '0' &&
    body.message !== EtherscanLikeExplorerApiErrors.NO_RECORD &&
    body.message !== EtherscanLikeExplorerApiErrors.NO_LOGS_FOUND
  ) {
    throw new Error(
      `Error while performing request to Etherscan like API at ${explorerUrl.host}: ${body.message} ${body.result}`,
    );
  }

  return body.result;
}

function getFormPostRequestBody<
  T extends BaseEtherscanLikeAPIParams<
    EtherscanLikeExplorerApiModule,
    EtherscanLikeExplorerApiAction
  >,
>(input: T): RequestInit {
  const formParams = new URLSearchParams(
    Object.entries(input).filter(([_key, value]) => !isNullish(value)),
  );

  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formParams,
  };
}

interface GetContractDeploymentTransaction extends BaseEtherscanLikeAPIParams<
  EtherscanLikeExplorerApiModule.CONTRACT,
  EtherscanLikeExplorerApiAction.GET_CONTRACT_CREATION_CODE
> {
  contractaddresses: Address;
}

type RawGetContractDeploymentTransactionResponse = {
  contractAddress: Address;
  contractCreator: Address;
  txHash: HexString;
  // Etherscan and Blockscout report the deployment block as a decimal string
  // while other explorers report it as a JSON number, and some omit it
  blockNumber?: string | number;
};

type GetContractDeploymentTransactionResponse = {
  contractAddress: Address;
  contractCreator: Address;
  txHash: HexString;
  blockNumber?: number;
};

export async function tryGetContractDeploymentTransaction(
  explorerOptions: EtherscanLikeAPIOptions,
  { contractAddress }: { contractAddress: Address },
): Promise<GetContractDeploymentTransactionResponse | undefined> {
  const options: GetContractDeploymentTransaction = {
    module: EtherscanLikeExplorerApiModule.CONTRACT,
    action: EtherscanLikeExplorerApiAction.GET_CONTRACT_CREATION_CODE,
    contractaddresses: contractAddress,
  };

  const requestUrl = formatExplorerUrl(explorerOptions, options);
  const response = await fetch(requestUrl);

  const [deploymentTx] =
    await handleEtherscanResponse<
      Array<RawGetContractDeploymentTransactionResponse>
    >(response);

  if (!deploymentTx) {
    return undefined;
  }

  return {
    contractAddress: deploymentTx.contractAddress,
    contractCreator: deploymentTx.contractCreator,
    txHash: deploymentTx.txHash,
    blockNumber: isNullish(deploymentTx.blockNumber)
      ? undefined
      : toNumber(deploymentTx.blockNumber, 'blockNumber'),
  };
}

/**
 * An explorer that has no record of a contract's deployment transaction will
 * keep answering the same way, so `retryAsync` must not spend attempts on it.
 */
class ContractDeploymentTransactionNotFoundError extends Error {
  readonly isRecoverable = false;

  constructor(contractAddress: Address) {
    super(`No deployment transaction found for contract ${contractAddress}`);
    this.name = 'ContractDeploymentTransactionNotFoundError';
  }
}

export async function getContractDeploymentTransaction(
  explorerOptions: EtherscanLikeAPIOptions,
  requestOptions: { contractAddress: Address },
): Promise<GetContractDeploymentTransactionResponse> {
  const deploymentTx = await tryGetContractDeploymentTransaction(
    explorerOptions,
    requestOptions,
  );

  if (!deploymentTx) {
    throw new ContractDeploymentTransactionNotFoundError(
      requestOptions.contractAddress,
    );
  }

  return deploymentTx;
}

// based on https://docs.etherscan.io/api-endpoints/logs
interface GetEventLogs extends BaseEtherscanLikeAPIParams<
  EtherscanLikeExplorerApiModule.LOGS,
  EtherscanLikeExplorerApiAction.GET_LOGS
> {
  address: Address;
  fromBlock: number;
  toBlock: number;
  topic0: string;
  page: number;
  offset: number;
}

type GetEventLogsOptions = Omit<
  GetEventLogs,
  'module' | 'action' | 'page' | 'offset'
>;

type ExplorerLogRangeOptions = {
  address?: Address;
  fromBlock?: number | 'latest';
  toBlock?: number | 'latest';
};

type ExplorerLogIdentity = {
  blockNumber: number | string;
  transactionHash: string;
  logIndex: number | string;
};

// Records per page and pages per block range, both measured against Etherscan
// V2 on chainid 1: a request that names neither is answered with the first 1000
// records of the range under a success status, and page 11 is refused whatever
// the offset. Their product is therefore the most logs the endpoint will hand
// over for one block range.
const EXPLORER_LOGS_PAGE_SIZE = 1_000;
const MAX_EXPLORER_LOG_PAGES = 10;

/**
 * Thrown when a block range holds more logs than the explorer will page
 * through. What has been collected by then is a prefix of the range rather than
 * the whole of it, and nothing in the responses says so, so it is dropped
 * instead of returned.
 *
 * The ceiling is a property of the endpoint rather than of the moment, so
 * `retryAsync` must not spend attempts on it: `isRecoverable = false` sends a
 * reader or composite provider to its RPC fallback on the first response, and
 * that fallback paginates by block and so has no equivalent ceiling.
 */
class ExplorerLogPageLimitError extends Error {
  readonly isRecoverable = false;

  constructor(options: ExplorerLogRangeOptions) {
    super(
      `Explorer served ${MAX_EXPLORER_LOG_PAGES} full pages of ${EXPLORER_LOGS_PAGE_SIZE} logs ${describeExplorerLogRange(options)}, which is as far as it pages, so the logs of that range cannot be read in full`,
    );
    this.name = 'ExplorerLogPageLimitError';
  }
}

/**
 * Thrown when a page of a block range's logs could not be read.
 *
 * The pages before it were served, so asking for the range again would repeat
 * them, and the retries this page is worth have already been spent below. It
 * therefore carries the same `isRecoverable = false` as the ceiling above, so a
 * reader or composite provider moves on to its RPC fallback instead of
 * restarting a read that is nine tenths done.
 */
class ExplorerLogPageReadError extends Error {
  readonly isRecoverable = false;

  constructor(page: number, options: ExplorerLogRangeOptions, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Explorer failed to serve page ${page} of the logs ${describeExplorerLogRange(options)}: ${reason}`,
      { cause },
    );
    this.name = 'ExplorerLogPageReadError';
  }
}

function describeExplorerLogRange({
  address,
  fromBlock,
  toBlock,
}: ExplorerLogRangeOptions): string {
  const addressDescription = address ? `for contract ${address} ` : '';
  return `${addressDescription}between blocks ${fromBlock ?? 'earliest'} and ${toBlock ?? 'latest'}`;
}

type RawEtherscanGetEventLogsResponse = {
  address: Address;
  blockNumber: HexString;
  data: HexString;
  gasPrice: HexString;
  gasUsed: HexString;
  logIndex: HexString;
  timeStamp: HexString;
  topics: ReadonlyArray<HexString>;
  transactionHash: HexString;
  transactionIndex: HexString;
};

// Explorers report a zero valued field as a bare "0x", which Number reads as
// NaN: NaN compares false against everything, so a log index that arrived that
// way silently loses the ordering comparisons the callers of this run on. A
// field that is not a number at all throws here, which sends the reader to its
// RPC fallback rather than into the same silence.
function toEventLogsResponse(
  rawLog: RawEtherscanGetEventLogsResponse,
): GetEventLogsResponse {
  return {
    address: rawLog.address,
    blockNumber: toNumber(rawLog.blockNumber, 'blockNumber'),
    data: rawLog.data,
    logIndex: toNumber(rawLog.logIndex, 'logIndex'),
    topics: rawLog.topics,
    transactionHash: rawLog.transactionHash,
    transactionIndex: toNumber(rawLog.transactionIndex, 'transactionIndex'),
  };
}

// A block whose logs straddle a page boundary is served at the end of one page
// and again at the start of the next, so concatenating pages would repeat it.
// The three fields together identify a log whether the explorer scopes
// logIndex to the block or to the transaction.
function logIdentity(log: ExplorerLogIdentity): string {
  return `${toNumber(log.blockNumber, 'blockNumber')}:${log.transactionHash.toLowerCase()}:${toNumber(log.logIndex, 'logIndex')}`;
}

// Retrying the page rather than the read is what keeps a rate limited page from
// re-requesting the pages already served. Only the request is retried: a
// response the explorer did serve is judged once, by the caller.
async function readExplorerLogPage<T>(
  readPage: () => Promise<T>,
  page: number,
  options: ExplorerLogRangeOptions,
): Promise<T> {
  try {
    return await retryAsync(readPage);
  } catch (error) {
    throw new ExplorerLogPageReadError(page, options, error);
  }
}

/**
 * Reads every explorer page for a log range or throws without returning the
 * prefix collected so far. Both direct explorer reads and explorer providers
 * use this so a successful getLogs response has the same completeness contract.
 */
export async function readPaginatedExplorerLogs<T extends ExplorerLogIdentity>(
  options: ExplorerLogRangeOptions,
  readPage: (page: number, offset: number) => Promise<T[]>,
): Promise<T[]> {
  const logsByIdentity = new Map<string, T>();

  for (let page = 1; page <= MAX_EXPLORER_LOG_PAGES; page++) {
    const pageLogs = await readExplorerLogPage(
      () => readPage(page, EXPLORER_LOGS_PAGE_SIZE),
      page,
      options,
    );
    assert(
      Array.isArray(pageLogs),
      `Explorer did not return a list of logs ${describeExplorerLogRange(options)}`,
    );

    for (const log of pageLogs) {
      logsByIdentity.set(logIdentity(log), log);
    }

    // A page the explorer could not fill is the last one it has.
    if (pageLogs.length < EXPLORER_LOGS_PAGE_SIZE) {
      return [...logsByIdentity.values()];
    }
  }

  throw new ExplorerLogPageLimitError(options);
}

export async function getLogsFromEtherscanLikeExplorerAPI(
  { apiUrl, apiKey: apikey }: EtherscanLikeAPIOptions,
  options: GetEventLogsOptions,
): Promise<Array<GetEventLogsResponse>> {
  const rawLogs = await readPaginatedExplorerLogs(
    options,
    async (page, offset) => {
      const data: GetEventLogs = {
        module: EtherscanLikeExplorerApiModule.LOGS,
        action: EtherscanLikeExplorerApiAction.GET_LOGS,
        address: options.address,
        fromBlock: options.fromBlock,
        toBlock: options.toBlock,
        topic0: options.topic0,
        page,
        offset,
      };

      const requestUrl = formatExplorerUrl({ apiUrl, apiKey: apikey }, data);
      const response = await fetch(requestUrl);
      return handleEtherscanResponse<RawEtherscanGetEventLogsResponse[]>(
        response,
      );
    },
  );

  return rawLogs.map(toEventLogsResponse);
}

interface GetContractVerificationStatus extends BaseEtherscanLikeAPIParams<
  EtherscanLikeExplorerApiModule.CONTRACT,
  EtherscanLikeExplorerApiAction.GETSOURCECODE
> {
  address: Address;
}

type GetContractSourceCodeResponse = {
  SourceCode: string;
  ContractName: string;
  CompilerVersion: string;
  OptimizationUsed: string;
  Runs: string;
  ConstructorArguments: string;
  EVMVersion: string;
  Library: string;
  LicenseType: string;
  Proxy: string;
  Implementation: string;
  SwarmSource: string;
  SimilarMatch: string;
};

export async function getContractSourceCode(
  explorerOptions: EtherscanLikeAPIOptions,
  { contractAddress }: { contractAddress: Address },
): Promise<GetContractSourceCodeResponse> {
  const options: GetContractVerificationStatus = {
    action: EtherscanLikeExplorerApiAction.GETSOURCECODE,
    address: contractAddress,
    module: EtherscanLikeExplorerApiModule.CONTRACT,
  };

  const requestUrl = formatExplorerUrl(explorerOptions, options);
  const response = await fetch(requestUrl);

  const [sourceCodeResults] =
    await handleEtherscanResponse<Array<GetContractSourceCodeResponse>>(
      response,
    );

  return sourceCodeResults;
}

type VerifyImplementationContractViaSolidityStandardJsonOptions = {
  sourceCode: SolidityStandardJsonInput;
  contractName: string;
  contractAddress: Address;
  compilerVersion: string;
  zkCompilerVersion?: string;
  licenseType?: ExplorerLicenseType;
  constructorArguments?: HexString;
};

interface RawVerifyImplementationContractViaSolidityStandardJsonOptions extends BaseEtherscanLikeAPIParams<
  EtherscanLikeExplorerApiModule.CONTRACT,
  EtherscanLikeExplorerApiAction.VERIFY_IMPLEMENTATION
> {
  codeformat: 'solidity-standard-json-input';
  compilerversion: string; // see https://etherscan.io/solcversions for list of support versions
  licenseType?: ExplorerLicenseType;
  zksolcversion?: string; //only for zksync chains
  contractaddress: string;
  sourceCode: string;
  contractname: string;
  /* TYPO IS ENFORCED BY API */
  constructorArguements?: string;
}

/**
 * Wrapper function for the `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=verifysourcecode&apikey=...`
 * endpoint request with the `codeformat` option set to `solidity-standard-json-input`
 */
export async function verifyContractSourceCodeViaStandardJsonInput(
  explorerOptions: EtherscanLikeAPIOptions,
  verificationOptions: VerifyImplementationContractViaSolidityStandardJsonOptions,
): Promise<string> {
  const input: RawVerifyImplementationContractViaSolidityStandardJsonOptions = {
    module: EtherscanLikeExplorerApiModule.CONTRACT,
    action: EtherscanLikeExplorerApiAction.VERIFY_IMPLEMENTATION,
    codeformat: 'solidity-standard-json-input',
    compilerversion: verificationOptions.compilerVersion,
    contractaddress: verificationOptions.contractAddress,
    contractname: verificationOptions.contractName,
    sourceCode: JSON.stringify(verificationOptions.sourceCode),
    constructorArguements: strip0x(
      verificationOptions.constructorArguments ?? '',
    ),
    licenseType: verificationOptions.licenseType,
  };

  if (!isNullish(verificationOptions.zkCompilerVersion)) {
    input.zksolcversion = verificationOptions.zkCompilerVersion;
  }

  const params = pick(input, ['action', 'module']);

  const requestUrl = formatExplorerUrl(explorerOptions, params);
  const response = await fetch(requestUrl, getFormPostRequestBody(input));

  return handleEtherscanResponse(response);
}

type VerifyProxyContractOptions = {
  contractAddress: Address;
  implementationAddress: Address;
};

interface RawVerifyProxyContractOptions extends BaseEtherscanLikeAPIParams<
  EtherscanLikeExplorerApiModule.CONTRACT,
  EtherscanLikeExplorerApiAction.VERIFY_PROXY
> {
  address: Address;
  expectedimplementation: Address;
}

/**
 * Wrapper function for the `https://api.etherscan.io/v2/api?chainid=...&module=contract&action=verifyproxycontract&apikey=...`
 */
export async function verifyProxyContract(
  explorerOptions: EtherscanLikeAPIOptions,
  { contractAddress, implementationAddress }: VerifyProxyContractOptions,
): Promise<string> {
  const input: RawVerifyProxyContractOptions = {
    action: EtherscanLikeExplorerApiAction.VERIFY_PROXY,
    module: EtherscanLikeExplorerApiModule.CONTRACT,
    address: contractAddress,
    expectedimplementation: implementationAddress,
  };

  const params = pick(input, ['action', 'module']);

  const requestUrl = formatExplorerUrl(explorerOptions, params);
  const response = await fetch(requestUrl, getFormPostRequestBody(input));

  return handleEtherscanResponse(response);
}

interface RawGetContractVerificationStatus extends BaseEtherscanLikeAPIParams<
  EtherscanLikeExplorerApiModule.CONTRACT,
  | EtherscanLikeExplorerApiAction.CHECK_IMPLEMENTATION_STATUS
  | EtherscanLikeExplorerApiAction.CHECK_PROXY_STATUS
> {
  guid: string;
}

/**
 * Wrapper function for the
 * `https://api.etherscan.io/v2/api?chainid=...&module=contract&action=...&guid=...&apikey=...`
 * endpoint request with the `action` option set to `checkverifystatus` if `isProxy` is false
 * or set to `checkproxyverification` if set to true.
 */
export async function checkContractVerificationStatus(
  explorerOptions: EtherscanLikeAPIOptions,
  { isProxy, verificationId }: { verificationId: string; isProxy: boolean },
): Promise<void> {
  const input: RawGetContractVerificationStatus = {
    action: isProxy
      ? EtherscanLikeExplorerApiAction.CHECK_PROXY_STATUS
      : EtherscanLikeExplorerApiAction.CHECK_IMPLEMENTATION_STATUS,
    guid: verificationId,
    module: EtherscanLikeExplorerApiModule.CONTRACT,
  };

  const requestUrl = formatExplorerUrl(explorerOptions, input);
  const response = await fetch(requestUrl);

  await handleEtherscanResponse(response);
}
