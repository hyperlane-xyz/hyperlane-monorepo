import { ethers } from 'ethers';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { Address, ChainId, eqAddress } from '@hyperlane-xyz/utils';

import { transferOwnershipTransactions } from '../contracts/contracts.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { DeployedOwnableConfig } from '../types.js';

export type UpgradeConfig = {
  timelock: {
    delay: number;
    // canceller inherited from proposer and admin not supported
    roles: {
      executor: Address;
      proposer: Address;
    };
  };
};

export async function proxyImplementation(
  provider: ethers.providers.Provider,
  proxy: Address,
): Promise<Address> {
  // Hardcoded storage slot for implementation per EIP-1967
  const storageValue = await provider.getStorageAt(
    proxy,
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  );
  return ethers.utils.getAddress(storageValue.slice(26));
}

export async function isInitialized(
  provider: ethers.providers.Provider,
  contract: Address,
): Promise<boolean> {
  // Using OZ's Initializable 4.9 which keeps it at the 0x0 slot
  const storageValue = await provider.getStorageAt(contract, '0x0');
  return (
    storageValue ===
    '0x00000000000000000000000000000000000000000000000000000000000000ff'
  );
}

export async function proxyAdmin(
  provider: ethers.providers.Provider,
  proxy: Address,
): Promise<Address> {
  // Hardcoded storage slot for admin per EIP-1967
  const storageValue = await provider.getStorageAt(
    proxy,
    '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  );

  // Return zero address if storage value is empty
  if (storageValue === '0x' || storageValue === '0x0') {
    return ethers.constants.AddressZero;
  }

  return ethers.utils.getAddress(storageValue.slice(26));
}

export function proxyConstructorArgs<C extends ethers.Contract>(
  implementation: C,
  proxyAdmin: string,
  initializeArgs?: Parameters<C['initialize']>,
): [string, string, string] {
  const initData = initializeArgs
    ? implementation.interface.encodeFunctionData('initialize', initializeArgs)
    : '0x';
  return [implementation.address, proxyAdmin, initData];
}

export async function isProxy(
  provider: ethers.providers.Provider,
  proxy: Address,
): Promise<boolean> {
  const admin = await proxyAdmin(provider, proxy);
  return !eqAddress(admin, ethers.constants.AddressZero);
}

export function proxyAdminUpdateTxs(
  chainId: ChainId,
  proxyAddress: Address,
  actualConfig: Readonly<{ proxyAdmin?: DeployedOwnableConfig }>,
  expectedConfig: Readonly<{ proxyAdmin?: DeployedOwnableConfig }>,
): AnnotatedEV5Transaction[] {
  const transactions: AnnotatedEV5Transaction[] = [];

  // Return early because old config files did not have the
  // proxyAdmin property
  if (!expectedConfig.proxyAdmin?.address) {
    return transactions;
  }

  const actualProxyAdmin = actualConfig.proxyAdmin!;
  const parsedChainId =
    typeof chainId === 'string' ? parseInt(chainId) : chainId;

  if (
    actualProxyAdmin.address &&
    actualProxyAdmin.address !== expectedConfig.proxyAdmin.address
  ) {
    transactions.push({
      chainId: parsedChainId,
      annotation: `Updating ProxyAdmin for proxy at "${proxyAddress}" from "${actualProxyAdmin.address}" to "${expectedConfig.proxyAdmin.address}"`,
      to: actualProxyAdmin.address,
      data: ProxyAdmin__factory.createInterface().encodeFunctionData(
        'changeProxyAdmin(address,address)',
        [proxyAddress, expectedConfig.proxyAdmin.address],
      ),
    });
  } else {
    transactions.push(
      // Internally the createTransferOwnershipTx method already checks if the
      // two owner values are the same and produces an empty tx batch if they are
      ...transferOwnershipTransactions(
        parsedChainId,
        actualProxyAdmin.address!,
        actualProxyAdmin,
        expectedConfig.proxyAdmin,
      ),
    );
  }

  return transactions;
}
