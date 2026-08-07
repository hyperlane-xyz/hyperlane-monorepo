import {
  Address,
  HexString,
  isNullish,
  pick,
  strip0x,
} from '@hyperlane-xyz/utils';

import type { SolidityStandardJsonInput } from '../deploy/verify/types.js';
import { GetEventLogsResponse } from '../rpc/evm/types.js';

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

type EtherscanResponseBody = {
  status?: unknown;
  message?: unknown;
  result?: unknown;
};

function assertEtherscanBodyOk(
  body: EtherscanResponseBody,
  responseUrl: string,
): void {
  const explorerUrl = new URL(responseUrl);
  // Avoid throwing if no logs are found for the current address
  if (
    body.status === '0' &&
    body.message !== EtherscanLikeExplorerApiErrors.NO_RECORD &&
    body.message !== EtherscanLikeExplorerApiErrors.NO_LOGS_FOUND
  ) {
    throw new Error(
      `Error while performing request to Etherscan like API at ${explorerUrl.host}: ${String(body.message)} ${String(body.result)}`,
    );
  }
}

async function handleEtherscanResponse<T>(response: Response): Promise<T> {
  const body = await response.json();

  assertEtherscanBodyOk(body, response.url);

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

type GetContractDeploymentTransactionResponse = {
  contractAddress: Address;
  contractCreator: Address;
  txHash: HexString;
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
      Array<GetContractDeploymentTransactionResponse>
    >(response);

  return deploymentTx;
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
    throw new Error(
      `No deployment transaction found for contract ${requestOptions.contractAddress}`,
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

// Records requested per page. Etherscan caps `logs/getLogs` here and reports a
// capped page as a success, so a page of exactly this size means "there may be
// more" rather than "that is everything".
const EXPLORER_LOGS_PAGE_SIZE = 1000;

// Upper bound on pages walked for a single query, so a clone that ignores
// `page` cannot spin forever and an unexpectedly large result set fails loudly
// instead of being silently truncated. 20 pages is 20,000 records for one
// contract and topic, well above anything this SDK reads today.
const EXPLORER_LOGS_MAX_PAGES = 20;

// Messages explorers use to reject a page outright, rather than to report a
// transient condition. Best-effort recognition: an unrecognized failure is
// treated as transient, so it is retried rather than abandoning the explorer.
const EXPLORER_PAGINATION_REJECTIONS = [
  'result window is too large',
  'pageno x offset',
];

function isNoRecordsMessage(message: string | undefined): boolean {
  return (
    message === EtherscanLikeExplorerApiErrors.NO_RECORD ||
    message === EtherscanLikeExplorerApiErrors.NO_LOGS_FOUND
  );
}

// Explorers split the detail across `message` and `result` inconsistently:
// zkSync answers a rejected page with message "NOTOK" and puts the reason in
// `result`, so both are searched.
function isPaginationRejection(body: EtherscanResponseBody): boolean {
  const detail = [body.message, body.result]
    .filter((field) => typeof field === 'string')
    .join(' ')
    .toLowerCase();
  return EXPLORER_PAGINATION_REJECTIONS.some((rejection) =>
    detail.includes(rejection),
  );
}

function incompleteExplorerLogsError(
  address: Address,
  reason: string,
  cause?: unknown,
): Error & { isRecoverable: boolean } {
  // Not recoverable: retrying the same query reproduces it. Callers that have a
  // fallback should use it, since the result cannot be shown to be complete.
  return Object.assign(
    new Error(
      `Unable to read a complete set of logs for ${address} from the block explorer: ${reason}`,
      { cause },
    ),
    { isRecoverable: false },
  );
}

export type RawEtherscanGetEventLogsResponse = {
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

/**
 * Reads every log matching the query, walking the explorer's pages until one
 * comes back short.
 *
 * A single request cannot distinguish "that is all of them" from "that is as
 * many as the page holds", so the result is only known to be complete once a
 * page arrives with fewer records than were asked for. Throws rather than
 * returning a partial set when that cannot be established.
 */
export async function getLogsFromEtherscanLikeExplorerAPI(
  { apiUrl, apiKey: apikey }: EtherscanLikeAPIOptions,
  options: Omit<GetEventLogs, 'module' | 'action' | 'page' | 'offset'>,
): Promise<Array<GetEventLogsResponse>> {
  const rawLogs: RawEtherscanGetEventLogsResponse[] = [];
  let previousPageMarker: string | undefined;

  for (let page = 1; page <= EXPLORER_LOGS_MAX_PAGES; page++) {
    const data: GetEventLogs = {
      module: EtherscanLikeExplorerApiModule.LOGS,
      action: EtherscanLikeExplorerApiAction.GET_LOGS,
      address: options.address,
      fromBlock: options.fromBlock,
      toBlock: options.toBlock,
      topic0: options.topic0,
      page,
      offset: EXPLORER_LOGS_PAGE_SIZE,
    };

    const requestUrl = formatExplorerUrl({ apiUrl, apiKey: apikey }, data);

    const response = await fetch(requestUrl);
    const body = await response.json();
    const message =
      typeof body?.message === 'string' ? body.message : undefined;

    // A page past the end of the data. Recognized before the generic status
    // check because it is the walk's normal termination rather than a failure.
    // Gated on the status as well: a success carrying this message alongside a
    // full page would otherwise drop that page and report the rest as complete.
    if (body.status === '0' && isNoRecordsMessage(message)) {
      return rawLogs.map(toGetEventLogsResponse);
    }

    // The explorer refuses to serve this page at all, so the walk cannot
    // finish here or on a retry.
    if (isPaginationRejection(body)) {
      throw incompleteExplorerLogsError(
        options.address,
        `page ${page} was rejected by the explorer: ${String(body.message)} ${String(body.result)}`,
      );
    }

    // Anything else that failed is transient as far as we can tell — a rate
    // limit, a timeout, an outage — so it stays retryable.
    assertEtherscanBodyOk(body, response.url);

    const result: unknown = body.result;
    if (!Array.isArray(result)) {
      // A success carrying something other than a list of records. Trusting it
      // as the end of the walk would turn a partial set into a complete one.
      throw new Error(
        `Unexpected response reading logs for ${options.address} from the block explorer: page ${page} was a success carrying no record list`,
      );
    }
    const pageLogs: RawEtherscanGetEventLogsResponse[] = result;
    if (pageLogs.length === 0) {
      return rawLogs.map(toGetEventLogsResponse);
    }

    // Some clones ignore `page` and keep answering with the first one. Walking
    // further would loop until the page cap and duplicate every record.
    const pageMarker = `${pageLogs[0].transactionHash}:${pageLogs[0].logIndex}`;
    if (pageMarker === previousPageMarker) {
      throw incompleteExplorerLogsError(
        options.address,
        `page ${page} repeated the previous page, so the explorer appears to ignore pagination`,
      );
    }
    previousPageMarker = pageMarker;

    rawLogs.push(...pageLogs);

    // A short page is the only proof that the set is complete.
    if (pageLogs.length < EXPLORER_LOGS_PAGE_SIZE) {
      return rawLogs.map(toGetEventLogsResponse);
    }
  }

  // The loop only runs to completion when every page was full, which leaves the
  // set unproven.
  throw incompleteExplorerLogsError(
    options.address,
    `every one of the ${EXPLORER_LOGS_MAX_PAGES} pages read was full, so more records may remain`,
  );
}

function toGetEventLogsResponse(
  rawLog: RawEtherscanGetEventLogsResponse,
): GetEventLogsResponse {
  return {
    address: rawLog.address,
    blockNumber: Number(rawLog.blockNumber),
    data: rawLog.data,
    logIndex: Number(rawLog.logIndex),
    topics: rawLog.topics,
    transactionHash: rawLog.transactionHash,
    transactionIndex: Number(rawLog.transactionIndex),
  };
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
