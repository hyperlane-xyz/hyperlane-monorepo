import { ethers } from 'ethers';
import { type Provider as ZKSyncProvider } from 'zksync-ethers';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { type Address, type ChainId, eqAddress } from '@hyperlane-xyz/utils';

import { transferOwnershipTransactions } from '../contracts/contracts.js';
import { type AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { type DeployedOwnableConfig } from '../types.js';

export type EthersLikeProvider = ethers.providers.Provider | ZKSyncProvider;

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

/**
 * Checks if a storage value represents empty/uninitialized storage.
 * Some RPC providers (e.g., Somnia) return empty hex strings ('0x' or '')
 * instead of the standard '0x0' for uninitialized storage slots.
 * @param rawValue - The raw storage value from provider.getStorageAt()
 * @returns true if the storage slot is empty/uninitialized
 */
export function isStorageEmpty(rawValue: string): boolean {
  return rawValue === '0x' || rawValue === '' || rawValue === '0x0';
}

async function assertCodeExists(
  provider: EthersLikeProvider,
  contract: Address,
): Promise<void> {
  const code = await provider.getCode(contract);
  if (code === '0x') {
    throw new Error(`Contract at ${contract} has no code`);
  }
}

export async function proxyImplementation(
  provider: EthersLikeProvider,
  proxy: Address,
): Promise<Address> {
  await assertCodeExists(provider, proxy);
  // Hardcoded storage slot for implementation per EIP-1967
  const storageValue = await provider.getStorageAt(
    proxy,
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  );
  if (isStorageEmpty(storageValue)) {
    return ethers.constants.AddressZero;
  }
  return ethers.utils.getAddress(storageValue.slice(26));
}

export async function isInitialized(
  provider: EthersLikeProvider,
  contract: Address,
): Promise<boolean> {
  await assertCodeExists(provider, contract);
  // Using OZ's Initializable 4.9 which keeps it at the 0x0 slot
  const storageValue = await provider.getStorageAt(contract, '0x0');
  if (isStorageEmpty(storageValue)) {
    return false;
  }
  const value = ethers.BigNumber.from(storageValue);
  return value.eq(1) || value.eq(255);
}

export async function proxyAdmin(
  provider: EthersLikeProvider,
  proxy: Address,
): Promise<Address> {
  await assertCodeExists(provider, proxy);
  // Hardcoded storage slot for admin per EIP-1967
  const storageValue = await provider.getStorageAt(
    proxy,
    '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  );
  if (isStorageEmpty(storageValue)) {
    return ethers.constants.AddressZero;
  }
  return ethers.utils.getAddress(storageValue.slice(26));
}

export function proxyConstructorArgs<C extends ethers.Contract>(
  implementation: C,
  proxyAdmin: string,
  initializeArgs?: Parameters<C['initialize']>,
  initializeFnSignature = 'initialize',
): [string, string, string] {
  const initData = initializeArgs
    ? implementation.interface.encodeFunctionData(
        initializeFnSignature,
        initializeArgs,
      )
    : '0x';
  return [implementation.address, proxyAdmin, initData];
}

export async function isProxy(
  provider: EthersLikeProvider,
  proxy: Address,
): Promise<boolean> {
  const admin = await proxyAdmin(provider, proxy);
  return !eqAddress(admin, ethers.constants.AddressZero);
}

export function proxyAdminUpdateTxs(
  chainId: ChainId,
  proxyAddress: Address,
  actualConfig: Readonly<{ owner: string; proxyAdmin?: DeployedOwnableConfig }>,
  expectedConfig: Readonly<{
    owner: string;
    proxyAdmin?: DeployedOwnableConfig;
  }>,
): AnnotatedEV5Transaction[] {
  const transactions: AnnotatedEV5Transaction[] = [];

  const parsedChainId =
    typeof chainId === 'string' ? parseInt(chainId) : chainId;

  if (
    actualConfig.proxyAdmin?.address &&
    expectedConfig.proxyAdmin?.address &&
    actualConfig.proxyAdmin.address !== expectedConfig.proxyAdmin.address
  ) {
    transactions.push({
      chainId: parsedChainId,
      annotation: `Updating ProxyAdmin for proxy at "${proxyAddress}" from "${actualConfig.proxyAdmin.address}" to "${expectedConfig.proxyAdmin.address}"`,
      to: actualConfig.proxyAdmin.address,
      data: ProxyAdmin__factory.createInterface().encodeFunctionData(
        'changeProxyAdmin(address,address)',
        [proxyAddress, expectedConfig.proxyAdmin.address],
      ),
    });
  } else {
    const actualOwnershipConfig = actualConfig.proxyAdmin ?? {
      owner: actualConfig.owner,
    };
    const expectedOwnershipConfig = expectedConfig.proxyAdmin ?? {
      owner: expectedConfig.owner,
    };

    transactions.push(
      // Internally the createTransferOwnershipTx method already checks if the
      // two owner values are the same and produces an empty tx batch if they are
      ...transferOwnershipTransactions(
        parsedChainId,
        actualOwnershipConfig.address!,
        actualOwnershipConfig,
        expectedOwnershipConfig,
      ),
    );
  }

  return transactions;
}

const requiredProxyAdminFunctionSelectors = [
  'owner()',
  'getProxyAdmin(address)',
  'getProxyImplementation(address)',
  'upgrade(address,address)',
  'upgradeAndCall(address,address,bytes)',
  'changeProxyAdmin(address,address)',
].map((func) => ethers.utils.id(func).substring(2, 10));

/**
 * Check if contract bytecode matches ProxyAdmin patterns
 * This is more efficient than function calls but less reliable
 * @param provider The provider to use
 * @param address The contract address
 * @returns true if the bytecode suggests it's a ProxyAdmin
 */
export async function isProxyAdminFromBytecode(
  provider: EthersLikeProvider,
  address: Address,
): Promise<boolean> {
  const code = await provider.getCode(address);
  if (code === '0x') return false;
  return requiredProxyAdminFunctionSelectors.every((selector) =>
    code.includes(selector),
  );
}
