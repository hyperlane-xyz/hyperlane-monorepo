import { Address, HexString } from '@hyperlane-xyz/utils';

interface EtherscanAPIOptions {
  apiKey?: string;
  apiUrl: string;
}

function formatExplorerUrl(
  { apiUrl, apiKey }: EtherscanAPIOptions,
  params: Record<string, string | number | bigint>,
): string {
  // hack for blockscout API urls that in the explorer have the eth-rpc path set
  // as it will cause requests to fail
  const urlObject = new URL(apiUrl.replace('eth-rpc', ''));
  for (const [key, value] of Object.entries(params)) {
    urlObject.searchParams.append(key, value.toString());
  }

  if (apiKey) {
    urlObject.searchParams.append('apikey', apiKey);
  }

  return urlObject.toString();
}

async function handleEtherscanResponse<T>(response: Response): Promise<T> {
  const body = await response.json();

  if (body.status === '0') {
    throw new Error(
      `Error while performing request to Etherscan like API: ${body.message} ${body.result}`,
    );
  }

  return body.result;
}

type GetContractDeploymentTransaction = {
  module: 'contract';
  action: 'getcontractcreation';
  contractaddresses: Address;
};

type GetContractDeploymentTransactionResponse = {
  contractAddress: Address;
  contractCreator: Address;
  txHash: HexString;
};

export async function tryGetContractDeploymentTransaction(
  explorerOptions: EtherscanAPIOptions,
  { contractAddress }: { contractAddress: Address },
): Promise<GetContractDeploymentTransactionResponse | undefined> {
  const options: GetContractDeploymentTransaction = {
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: contractAddress,
  };

  const requestUrl = formatExplorerUrl(explorerOptions, options);
  const response = await fetch(requestUrl);

  const [deploymentTx] = await handleEtherscanResponse<
    Array<GetContractDeploymentTransactionResponse>
  >(response);

  return deploymentTx;
}

export async function getContractDeploymentTransaction(
  explorerOptions: EtherscanAPIOptions,
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
type GetEventLogs = {
  module: 'logs';
  action: 'getLogs';
  address: Address;
  fromBlock: number;
  toBlock: number;
  topic0: string;
};

export type GetEventLogsResponse = {
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

export async function getLogsFromEtherscanLikeExplorerAPI(
  { apiUrl, apiKey: apikey }: EtherscanAPIOptions,
  options: Omit<GetEventLogs, 'module' | 'action'>,
): Promise<Array<GetEventLogsResponse>> {
  const data: GetEventLogs = {
    module: 'logs',
    action: 'getLogs',
    address: options.address,
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    topic0: options.topic0,
  };

  const requestUrl = formatExplorerUrl({ apiUrl, apiKey: apikey }, data);

  const response = await fetch(requestUrl);

  return handleEtherscanResponse(response);
}
