import { TronWeb } from 'tronweb';

import { assert, isNullish, strip0x } from '@hyperlane-xyz/utils';

import { IABI, TronReceipt } from './types.js';
import { BigNumber, providers, utils } from 'ethers';

export const TRON_EMPTY_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
export const TRON_EMPTY_MESSAGE =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
export const EIP1967_ADMIN_SLOT =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

export function decodeRevertReason(hex: string): string {
  try {
    if (hex.startsWith('08c379a0')) {
      // Standard Error(string) selector — decode the ABI-encoded string payload.
      const data = '0x' + hex.substring(8);
      return String(utils.defaultAbiCoder.decode(['string'], data)[0]);
    }
    return `Hex Error: ${hex}`;
  } catch {
    return `Could not decode hex: ${hex}`;
  }
}

/**
 * Subset of a Tron transaction-info receipt needed to detect execution failure.
 *
 * `receipt` is optional because non-contract transfers surface no execution
 * receipt, and the top-level `result` is what flags those as failures.
 */
export type TronReceiptResult = Pick<
  TronReceipt,
  'resMessage' | 'contractResult' | 'result'
> &
  Partial<Pick<TronReceipt, 'receipt'>>;

/**
 * Throws when a mined Tron transaction reverted or failed on-chain.
 *
 * Tron surfaces execution failures through `getTransactionInfo` rather than the
 * broadcast result, so both the ethers-compatible wallet path (TronWallet) and
 * the AltVM provider path (TronProvider) must inspect the receipt to fail
 * loudly, mirroring EVM's CALL_EXCEPTION on a status-0 receipt.
 */
export function assertTronReceiptSuccess(
  info: TronReceiptResult,
  tronweb: TronWeb,
  txid: string,
): void {
  const nested = info.receipt?.result;
  const topLevelFailed = info.result === 'FAILED';
  // Nested receipt.result is Tron's contractResult enum (SUCCESS/REVERT/
  // OUT_OF_ENERGY/OUT_OF_TIME/...). Any value other than SUCCESS is a mined
  // failure. It is absent for non-contract transfers, which are not failures.
  const nestedFailed = !isNullish(nested) && nested !== 'SUCCESS';
  if (!topLevelFailed && !nestedFailed) {
    return;
  }

  let revertReason = 'Unknown Error';
  if (info.resMessage) {
    revertReason = tronweb.toUtf8(info.resMessage);
  } else if (info.contractResult && info.contractResult[0]) {
    revertReason = decodeRevertReason(info.contractResult[0]);
  }

  throw new Error(`Tron Transaction Failed: ${revertReason} (txid: ${txid})`);
}

export async function createDeploymentTransaction(
  tronweb: Readonly<TronWeb>,
  abi: IABI,
  signer: string,
  parameters: unknown[],
): Promise<any> {
  return tronweb.transactionBuilder.createSmartContract(
    {
      feeLimit: 1_000_000_000,
      abi: abi.abi,
      bytecode: abi.bytecode,
      parameters,
      name: abi.contractName,
    },
    signer,
  );
}

/**
 * Constructs MetaProxy bytecode that embeds metadata in the contract
 * @param implementationAddress - Address of implementation contract
 * @param metadata - ABI-encoded metadata to embed
 * @returns Complete MetaProxy bytecode
 */
export function buildMetaProxyBytecode(
  implementationAddress: string,
  metadata: string,
): string {
  const PREFIX =
    '600b380380600b3d393df3363d3d373d3d3d3d60368038038091363936013d73';
  const SUFFIX = '5af43d3d93803e603457fd5bf3';

  // Remove 0x prefix if present
  const cleanMetadata = strip0x(metadata);
  let cleanImpl = strip0x(implementationAddress);

  // Tron addresses have 41 prefix byte - strip it to get 20 bytes
  if (cleanImpl.startsWith('41')) {
    cleanImpl = cleanImpl.slice(2);
  }

  // Validate address is exactly 20 bytes (40 hex chars)
  if (cleanImpl.length !== 40) {
    throw new Error(
      `Implementation address must be 20 bytes (40 hex chars), got ${cleanImpl.length}`,
    );
  }

  // Convert metadata length to 32-byte hex (uint256)
  const metadataLength = (cleanMetadata.length / 2)
    .toString(16)
    .padStart(64, '0');

  return `0x${PREFIX}${cleanImpl}${SUFFIX}${cleanMetadata}${metadataLength}`;
}

/**
 * Deploys a contract using raw bytecode (for MetaProxy deployments)
 * @param tronweb - TronWeb instance
 * @param bytecode - Complete bytecode to deploy
 * @param signer - Deployer address
 * @param contractName - Optional name for the contract
 * @returns Transaction object
 */
export async function createRawBytecodeDeploymentTransaction(
  tronweb: Readonly<TronWeb>,
  bytecode: string,
  signer: string,
  contractName = 'MetaProxy',
): Promise<any> {
  return tronweb.transactionBuilder.createSmartContract(
    {
      feeLimit: 1_000_000_000,
      abi: [],
      bytecode,
      parameters: [],
      name: contractName,
    },
    signer,
  );
}

/**
 * Convert an address to Tron's 41-prefixed hex form.
 *
 * Accepts ethers 0x-hex, base58 (`T…`) or already-41-prefixed hex. Base58 is
 * resolved through TronWeb so the checksum is validated rather than assumed.
 */
export function toTronHex(tronWeb: Readonly<TronWeb>, address: string): string {
  if (address.startsWith('T')) {
    return tronWeb.address.toHex(address);
  }
  const hex = strip0x(address).toLowerCase();
  return hex.startsWith('41') && hex.length === 42 ? hex : `41${hex}`;
}

/**
 * Fields required to invoke a TronWeb transactionBuilder trigger
 * (`triggerSmartContract` write or `triggerConstantContract` read).
 */
export interface TronTriggerRequest {
  contractAddress: string;
  callValue: number;
  input?: string;
  issuerAddress: string;
}

/**
 * Builds a Tron contract-trigger request from an ethers transaction. Response
 * handling is left to the caller: writes assert on the build result, reads
 * return the raw constant-call data so ethers can surface reverts itself.
 *
 * The empty functionSelector tells TronWeb to use the raw ABI-encoded `input`
 * bytes directly instead of encoding named parameters.
 */
export function buildTronTriggerRequest(
  tronWeb: Readonly<TronWeb>,
  tx: providers.TransactionRequest,
  sender: string | undefined,
): TronTriggerRequest {
  assert(tx.to, 'Transaction must have a destination address');
  const contractAddress = toTronHex(tronWeb, tx.to);
  // A provider-connected ethers read omits `from`. Defaulting the caller to the
  // contract itself would run the call with msg.sender == address(this), so
  // caller-sensitive views return wrong/privileged state. Use the Tron zero
  // address as the caller instead, mirroring eth_call's default sender.
  const issuerAddress = isNullish(sender)
    ? toTronHex(tronWeb, TRON_EMPTY_ADDRESS)
    : toTronHex(tronWeb, sender);
  const callValue = tx.value ? BigNumber.from(tx.value).toNumber() : 0;
  const input = isNullish(tx.data)
    ? undefined
    : strip0x(utils.hexlify(tx.data));

  return { contractAddress, callValue, input, issuerAddress };
}

export async function convertEthersToTronTransaction(
  tronWeb: Readonly<TronWeb>,
  tx: providers.TransactionRequest,
  sender: string,
): Promise<any> {
  const { contractAddress, callValue, input, issuerAddress } =
    buildTronTriggerRequest(tronWeb, tx, sender);
  const response = await tronWeb.transactionBuilder.triggerSmartContract(
    contractAddress,
    '',
    { callValue, input },
    [],
    issuerAddress,
  );
  assert(
    response.result?.result,
    `triggerSmartContract failed: ${response.result?.message}`,
  );
  return response.transaction;
}
