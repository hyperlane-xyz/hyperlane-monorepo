import {
  CairoOption,
  CairoOptionVariant,
  type RawArgsArray,
  type RpcProvider,
} from 'starknet';

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
  signer: string,
  config: {
    mailboxAddress: string;
    feeTokenAddress: string;
    defaultHook: string;
    defaultIsm: string;
  },
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.HYP_NATIVE,
    contractType: ContractType.TOKEN,
    constructorArgs: [
      normalizeStarknetAddressSafe(config.mailboxAddress),
      normalizeStarknetAddressSafe(config.feeTokenAddress),
      normalizeStarknetAddressSafe(config.defaultHook),
      normalizeStarknetAddressSafe(config.defaultIsm),
      normalizeStarknetAddressSafe(signer),
    ],
  };
}

export function getCreateCollateralTokenTx(
  signer: string,
  config: {
    mailboxAddress: string;
    collateralDenom: string;
    defaultHook: string;
    defaultIsm: string;
  },
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.HYP_ERC20_COLLATERAL,
    contractType: ContractType.TOKEN,
    constructorArgs: [
      normalizeStarknetAddressSafe(config.mailboxAddress),
      normalizeStarknetAddressSafe(config.collateralDenom),
      normalizeStarknetAddressSafe(signer),
      normalizeStarknetAddressSafe(config.defaultHook),
      normalizeStarknetAddressSafe(config.defaultIsm),
    ],
  };
}

export function getCreateSyntheticTokenTx(
  signer: string,
  config: {
    mailboxAddress: string;
    name: string;
    denom: string;
    decimals: number;
    defaultHook: string;
    defaultIsm: string;
  },
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.HYP_ERC20,
    contractType: ContractType.TOKEN,
    constructorArgs: [
      config.decimals,
      normalizeStarknetAddressSafe(config.mailboxAddress),
      0, // initial supply
      config.name,
      config.denom,
      normalizeStarknetAddressSafe(config.defaultHook),
      normalizeStarknetAddressSafe(config.defaultIsm),
      normalizeStarknetAddressSafe(signer),
    ],
  };
}

export async function getSetTokenOwnerTx(
  provider: RpcProvider,
  config: {
    tokenAddress: string;
    newOwner: string;
  },
): Promise<StarknetAnnotatedTx> {
  const token = getStarknetContract(
    StarknetContractName.HYP_ERC20,
    config.tokenAddress,
    provider,
    ContractType.TOKEN,
  );
  return populateInvokeTx(token, 'transfer_ownership', [
    normalizeStarknetAddressSafe(config.newOwner),
  ]);
}

export async function getSetTokenIsmTx(
  provider: RpcProvider,
  config: {
    tokenAddress: string;
    ismAddress?: string;
  },
): Promise<StarknetAnnotatedTx> {
  const token = getStarknetContract(
    StarknetContractName.HYP_ERC20,
    config.tokenAddress,
    provider,
    ContractType.TOKEN,
  );
  return populateInvokeTx(token, 'set_interchain_security_module', [
    normalizeStarknetAddressSafe(config.ismAddress ?? ZERO_ADDRESS_HEX_32),
  ]);
}

export async function getSetTokenHookTx(
  provider: RpcProvider,
  config: {
    tokenAddress: string;
    hookAddress?: string;
  },
): Promise<StarknetAnnotatedTx> {
  const token = getStarknetContract(
    StarknetContractName.HYP_ERC20,
    config.tokenAddress,
    provider,
    ContractType.TOKEN,
  );
  return populateInvokeTx(token, 'set_hook', [
    normalizeStarknetAddressSafe(config.hookAddress ?? ZERO_ADDRESS_HEX_32),
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
  config: {
    tokenAddress: string;
    remoteRouter: {
      receiverDomainId: number;
      receiverAddress: string;
      gas: string;
    };
  },
): Promise<StarknetAnnotatedTx> {
  const receiverAddress = isZeroishAddress(config.remoteRouter.receiverAddress)
    ? ZERO_ADDRESS_HEX_32
    : ensure0x(config.remoteRouter.receiverAddress);

  const noneOption = new CairoOption(CairoOptionVariant.None);
  const domainOption = new CairoOption(
    CairoOptionVariant.Some,
    config.remoteRouter.receiverDomainId,
  );
  const gasOption = new CairoOption(
    CairoOptionVariant.Some,
    config.remoteRouter.gas,
  );

  const [enrollCall, gasCall] = await Promise.all([
    populateInvokeCall(provider, config.tokenAddress, 'enroll_remote_router', [
      config.remoteRouter.receiverDomainId,
      receiverAddress,
    ]),
    populateInvokeCall(provider, config.tokenAddress, 'set_destination_gas', [
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
  config: {
    tokenAddress: string;
    receiverDomainId: number;
  },
): Promise<StarknetAnnotatedTx> {
  const token = getStarknetContract(
    StarknetContractName.HYP_ERC20,
    config.tokenAddress,
    provider,
    ContractType.TOKEN,
  );
  return populateInvokeTx(token, 'unenroll_remote_router', [
    config.receiverDomainId,
  ]);
}
