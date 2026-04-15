import {
  CairoOption,
  CairoOptionVariant,
  type RawArgsArray,
  type RpcProvider,
} from 'starknet';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { ContractType } from '@hyperlane-xyz/starknet-core';
import {
  ZERO_ADDRESS_HEX_32,
  assert,
  ensure0x,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import {
  StarknetContractName,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
} from '../contracts.js';
import { type StarknetAnnotatedTx } from '../types.js';

export function getCreateNativeTokenTx(
  req: AltVM.ReqCreateNativeToken,
  mailboxDefaults: { defaultHook: string; defaultIsm: string },
  feeTokenAddress: string,
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.HYP_NATIVE,
    contractType: ContractType.TOKEN,
    constructorArgs: [
      normalizeStarknetAddressSafe(req.mailboxAddress),
      feeTokenAddress,
      normalizeStarknetAddressSafe(mailboxDefaults.defaultHook),
      normalizeStarknetAddressSafe(mailboxDefaults.defaultIsm),
      normalizeStarknetAddressSafe(req.signer),
    ],
  };
}

export function getCreateCollateralTokenTx(
  req: AltVM.ReqCreateCollateralToken,
  mailboxDefaults: { defaultHook: string; defaultIsm: string },
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.HYP_ERC20_COLLATERAL,
    contractType: ContractType.TOKEN,
    constructorArgs: [
      normalizeStarknetAddressSafe(req.mailboxAddress),
      normalizeStarknetAddressSafe(req.collateralDenom),
      normalizeStarknetAddressSafe(req.signer),
      normalizeStarknetAddressSafe(mailboxDefaults.defaultHook),
      normalizeStarknetAddressSafe(mailboxDefaults.defaultIsm),
    ],
  };
}

export function getCreateSyntheticTokenTx(
  req: AltVM.ReqCreateSyntheticToken,
  mailboxDefaults: { defaultHook: string; defaultIsm: string },
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.HYP_ERC20,
    contractType: ContractType.TOKEN,
    constructorArgs: [
      req.decimals,
      normalizeStarknetAddressSafe(req.mailboxAddress),
      0,
      req.name,
      req.denom,
      normalizeStarknetAddressSafe(mailboxDefaults.defaultHook),
      normalizeStarknetAddressSafe(mailboxDefaults.defaultIsm),
      normalizeStarknetAddressSafe(req.signer),
    ],
  };
}

export async function getSetTokenOwnerTx(
  provider: RpcProvider,
  req: AltVM.ReqSetTokenOwner,
): Promise<StarknetAnnotatedTx> {
  const token = getStarknetContract(
    StarknetContractName.HYP_ERC20,
    req.tokenAddress,
    provider,
    ContractType.TOKEN,
  );
  return populateInvokeTx(token, 'transfer_ownership', [
    normalizeStarknetAddressSafe(req.newOwner),
  ]);
}

export async function getSetTokenIsmTx(
  provider: RpcProvider,
  req: AltVM.ReqSetTokenIsm,
): Promise<StarknetAnnotatedTx> {
  const token = getStarknetContract(
    StarknetContractName.HYP_ERC20,
    req.tokenAddress,
    provider,
    ContractType.TOKEN,
  );
  return populateInvokeTx(token, 'set_interchain_security_module', [
    normalizeStarknetAddressSafe(req.ismAddress ?? ZERO_ADDRESS_HEX_32),
  ]);
}

export async function getSetTokenHookTx(
  provider: RpcProvider,
  req: AltVM.ReqSetTokenHook,
): Promise<StarknetAnnotatedTx> {
  const token = getStarknetContract(
    StarknetContractName.HYP_ERC20,
    req.tokenAddress,
    provider,
    ContractType.TOKEN,
  );
  return populateInvokeTx(token, 'set_hook', [
    normalizeStarknetAddressSafe(req.hookAddress ?? ZERO_ADDRESS_HEX_32),
  ]);
}

async function populateInvokeCall(
  provider: RpcProvider,
  tokenAddress: string,
  method: string,
  args: RawArgsArray = [],
): Promise<{
  contractAddress: string;
  entrypoint: string;
  calldata: RawArgsArray;
}> {
  const contract = getStarknetContract(
    StarknetContractName.HYP_ERC20,
    tokenAddress,
    provider,
    ContractType.TOKEN,
  );
  const tx = await populateInvokeTx(contract, method, args);
  assert(tx.kind === 'invoke', 'Expected invoke Starknet transaction');

  return {
    contractAddress: normalizeStarknetAddressSafe(tx.contractAddress),
    entrypoint: tx.entrypoint,
    calldata: tx.calldata,
  };
}

export async function getEnrollRemoteRouterTx(
  provider: RpcProvider,
  req: AltVM.ReqEnrollRemoteRouter,
): Promise<StarknetAnnotatedTx> {
  const receiverAddress = isZeroishAddress(req.remoteRouter.receiverAddress)
    ? ZERO_ADDRESS_HEX_32
    : ensure0x(req.remoteRouter.receiverAddress);

  const noneOption = new CairoOption(CairoOptionVariant.None);
  const domainOption = new CairoOption(
    CairoOptionVariant.Some,
    req.remoteRouter.receiverDomainId,
  );
  const gasOption = new CairoOption(
    CairoOptionVariant.Some,
    req.remoteRouter.gas,
  );

  const [enrollCall, gasCall] = await Promise.all([
    populateInvokeCall(provider, req.tokenAddress, 'enroll_remote_router', [
      req.remoteRouter.receiverDomainId,
      receiverAddress,
    ]),
    populateInvokeCall(provider, req.tokenAddress, 'set_destination_gas', [
      noneOption,
      domainOption,
      gasOption,
    ]),
  ]);

  return {
    kind: 'invoke',
    contractAddress: enrollCall.contractAddress,
    entrypoint: enrollCall.entrypoint,
    calldata: enrollCall.calldata,
    calls: [enrollCall, gasCall],
  };
}

export async function getUnenrollRemoteRouterTx(
  provider: RpcProvider,
  req: AltVM.ReqUnenrollRemoteRouter,
): Promise<StarknetAnnotatedTx> {
  const token = getStarknetContract(
    StarknetContractName.HYP_ERC20,
    req.tokenAddress,
    provider,
    ContractType.TOKEN,
  );
  return populateInvokeTx(token, 'unenroll_remote_router', [
    req.receiverDomainId,
  ]);
}
