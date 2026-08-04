import { Contract, providers, utils } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import {
  EIP1967_IMPLEMENTATION_SLOT,
  type BytecodeManifest,
  type BytecodeManifestSet,
  computeMaskedRuntimeHash,
} from './bytecodeManifest.js';

export enum BytecodeValidity {
  Match = 'match',
  Mismatch = 'mismatch',
  VersionUnavailable = 'version_unavailable',
  NoCode = 'no_code',
  Unsupported = 'unsupported',
}

export interface BytecodeComparison {
  address: string;
  implementationAddress: string;
  isProxy: boolean;
  onchainVersion?: string;
  validity: BytecodeValidity;
  matchedContractName?: string;
  expectedContractName?: string;
  onchainMaskedHash?: string;
  expectedHash?: string;
  note?: string;
}

function isZeroAddressStorageValue(storageValue: string): boolean {
  const normalized = storageValue.replace(/^0x/i, '').padStart(64, '0');
  return /^0+$/.test(normalized.slice(-40));
}

function implementationAddressFromStorage(storageValue: string): string {
  const normalized = storageValue.replace(/^0x/i, '').padStart(64, '0');
  return utils.getAddress(`0x${normalized.slice(-40)}`);
}

export async function resolveImplementation(
  provider: providers.Provider,
  address: string,
): Promise<{ isProxy: boolean; implementationAddress: string }> {
  assert(utils.isAddress(address), `Invalid EVM address ${address}`);

  const storageValue = await provider.getStorageAt(
    address,
    EIP1967_IMPLEMENTATION_SLOT,
  );
  if (isZeroAddressStorageValue(storageValue)) {
    return {
      isProxy: false,
      implementationAddress: utils.getAddress(address),
    };
  }

  return {
    isProxy: true,
    implementationAddress: implementationAddressFromStorage(storageValue),
  };
}

export async function readOnchainPackageVersion(
  provider: providers.Provider,
  address: string,
): Promise<string | undefined> {
  try {
    const contract = new Contract(
      address,
      ['function PACKAGE_VERSION() view returns (string)'],
      provider,
    );
    const version: unknown = await contract.PACKAGE_VERSION();
    if (typeof version === 'string') return version;
    return undefined;
  } catch {
    return undefined;
  }
}

function versionUnavailableComparison(params: {
  address: string;
  implementationAddress: string;
  isProxy: boolean;
  onchainVersion?: string;
  manifestSet: BytecodeManifestSet;
  note?: string;
}): BytecodeComparison {
  const availableVersions = Object.keys(params.manifestSet).sort().join(', ');
  return {
    address: utils.getAddress(params.address),
    implementationAddress: params.implementationAddress,
    isProxy: params.isProxy,
    onchainVersion: params.onchainVersion,
    validity: BytecodeValidity.VersionUnavailable,
    note:
      params.note ??
      `No bytecode manifest for on-chain version ${
        params.onchainVersion ?? '<unavailable>'
      }. Available versions: ${availableVersions || '<none>'}`,
  };
}

function compareAgainstManifest(params: {
  address: string;
  implementationAddress: string;
  isProxy: boolean;
  onchainVersion?: string;
  code: string;
  manifest: BytecodeManifest;
  expectedContractName?: string;
}): BytecodeComparison {
  const {
    address,
    implementationAddress,
    isProxy,
    onchainVersion,
    code,
    manifest,
    expectedContractName,
  } = params;

  if (expectedContractName) {
    const entry = manifest.byName[expectedContractName];
    if (!entry) {
      return {
        address: utils.getAddress(address),
        implementationAddress,
        isProxy,
        onchainVersion,
        validity: BytecodeValidity.Mismatch,
        expectedContractName,
        note: 'expected contract not in manifest',
      };
    }

    const onchainMaskedHash = computeMaskedRuntimeHash(
      code,
      entry.immutableRanges,
      entry.linkRanges,
    );
    const isMatch = onchainMaskedHash === entry.maskedRuntimeHash;
    return {
      address: utils.getAddress(address),
      implementationAddress,
      isProxy,
      onchainVersion,
      validity: isMatch ? BytecodeValidity.Match : BytecodeValidity.Mismatch,
      expectedContractName,
      matchedContractName: isMatch ? expectedContractName : undefined,
      onchainMaskedHash,
      expectedHash: entry.maskedRuntimeHash,
    };
  }

  for (const [contractName, entry] of Object.entries(manifest.byName)) {
    const onchainMaskedHash = computeMaskedRuntimeHash(
      code,
      entry.immutableRanges,
      entry.linkRanges,
    );
    if (onchainMaskedHash === entry.maskedRuntimeHash) {
      return {
        address: utils.getAddress(address),
        implementationAddress,
        isProxy,
        onchainVersion,
        validity: BytecodeValidity.Match,
        matchedContractName: contractName,
        onchainMaskedHash,
        expectedHash: entry.maskedRuntimeHash,
      };
    }
  }

  const firstEntry = Object.values(manifest.byName)[0];
  const onchainMaskedHash = firstEntry
    ? computeMaskedRuntimeHash(
        code,
        firstEntry.immutableRanges,
        firstEntry.linkRanges,
      )
    : computeMaskedRuntimeHash(code, [], []);

  return {
    address: utils.getAddress(address),
    implementationAddress,
    isProxy,
    onchainVersion,
    validity: BytecodeValidity.Mismatch,
    onchainMaskedHash,
    note: firstEntry
      ? `No manifest entry matched. Reporting hash masked with ${firstEntry.contractName} ranges.`
      : 'Manifest has no contracts.',
  };
}

function findComparisonAcrossManifests(params: {
  address: string;
  implementationAddress: string;
  isProxy: boolean;
  code: string;
  manifestSet: BytecodeManifestSet;
  expectedContractName?: string;
}): BytecodeComparison | undefined {
  for (const manifest of Object.values(params.manifestSet)) {
    const comparison = compareAgainstManifest({
      address: params.address,
      implementationAddress: params.implementationAddress,
      isProxy: params.isProxy,
      code: params.code,
      manifest,
      onchainVersion: manifest.packageVersion,
      expectedContractName: params.expectedContractName,
    });
    if (comparison.validity === BytecodeValidity.Match) return comparison;
  }
  return undefined;
}

export async function compareBytecode(
  provider: providers.Provider,
  address: string,
  manifestSet: BytecodeManifestSet,
  opts?: { expectedContractName?: string },
): Promise<BytecodeComparison> {
  const { isProxy, implementationAddress } = await resolveImplementation(
    provider,
    address,
  );
  const code = await provider.getCode(implementationAddress);
  if (code === '0x') {
    return {
      address: utils.getAddress(address),
      implementationAddress,
      isProxy,
      validity: BytecodeValidity.NoCode,
      note: 'implementation address has no code',
    };
  }

  const proxyVersion = await readOnchainPackageVersion(provider, address);
  const implementationVersion =
    proxyVersion ??
    (isProxy
      ? await readOnchainPackageVersion(provider, implementationAddress)
      : undefined);
  const onchainVersion = implementationVersion;

  if (!onchainVersion) {
    const matched = findComparisonAcrossManifests({
      address,
      implementationAddress,
      isProxy,
      code,
      manifestSet,
      expectedContractName: opts?.expectedContractName,
    });
    if (matched) return { ...matched, onchainVersion: undefined };

    return versionUnavailableComparison({
      address,
      implementationAddress,
      isProxy,
      manifestSet,
      note: 'PACKAGE_VERSION unavailable and no manifest hash matched.',
    });
  }

  const manifest = manifestSet[onchainVersion];
  if (!manifest) {
    return versionUnavailableComparison({
      address,
      implementationAddress,
      isProxy,
      onchainVersion,
      manifestSet,
    });
  }

  return compareAgainstManifest({
    address,
    implementationAddress,
    isProxy,
    code,
    manifest,
    onchainVersion,
    expectedContractName: opts?.expectedContractName,
  });
}

export async function scanAddressesBytecode(
  provider: providers.Provider,
  addresses: {
    address: string;
    expectedContractName?: string;
    label?: string;
  }[],
  manifestSet: BytecodeManifestSet,
): Promise<BytecodeComparison[]> {
  const comparisons: BytecodeComparison[] = [];
  for (const address of addresses) {
    comparisons.push(
      await compareBytecode(provider, address.address, manifestSet, {
        expectedContractName: address.expectedContractName,
      }),
    );
  }
  return comparisons;
}
