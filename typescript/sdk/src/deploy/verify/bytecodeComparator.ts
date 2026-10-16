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
  reportedVersion?: string;
  matchedPackageVersion?: string;
  versionSource?: 'onchain' | 'absent' | 'rpc_error';
  validity: BytecodeValidity;
  matchedContractName?: string;
  expectedContractName?: string;
  onchainMaskedHash?: string;
  expectedHash?: string;
  proxyValidity?: BytecodeValidity;
  proxyMatchedContractName?: string;
  note?: string;
}

export type PackageVersionRead =
  | { kind: 'version'; version: string }
  | { kind: 'absent' }
  | { kind: 'rpc_error' };

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
): Promise<PackageVersionRead> {
  try {
    const contract = new Contract(
      address,
      ['function PACKAGE_VERSION() view returns (string)'],
      provider,
    );
    const version: unknown = await contract.PACKAGE_VERSION();
    if (typeof version === 'string') return { kind: 'version', version };
    return { kind: 'absent' };
  } catch (error) {
    return classifyPackageVersionReadError(error);
  }
}

function classifyPackageVersionReadError(error: unknown): PackageVersionRead {
  const code = getErrorStringField(error, 'code');
  const message = [
    getErrorStringField(error, 'message'),
    getErrorStringField(error, 'reason'),
  ]
    .filter((part) => part)
    .join(' ')
    .toLowerCase();

  if (
    code === 'NETWORK_ERROR' ||
    code === 'TIMEOUT' ||
    code === 'SERVER_ERROR' ||
    message.includes('connection') ||
    message.includes('network') ||
    message.includes('timeout')
  ) {
    return { kind: 'rpc_error' };
  }

  return { kind: 'absent' };
}

function getErrorStringField(
  error: unknown,
  field: string,
): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function versionUnavailableComparison(params: {
  address: string;
  implementationAddress: string;
  isProxy: boolean;
  reportedVersion?: string;
  versionSource?: 'onchain' | 'absent' | 'rpc_error';
  manifestSet: BytecodeManifestSet;
  note?: string;
}): BytecodeComparison {
  const availableVersions = Object.keys(params.manifestSet).sort().join(', ');
  return {
    address: utils.getAddress(params.address),
    implementationAddress: params.implementationAddress,
    isProxy: params.isProxy,
    onchainVersion: params.reportedVersion,
    reportedVersion: params.reportedVersion,
    versionSource: params.versionSource,
    validity: BytecodeValidity.VersionUnavailable,
    note:
      params.note ??
      `No bytecode manifest for on-chain version ${
        params.reportedVersion ?? '<unavailable>'
      }. Available versions: ${availableVersions || '<none>'}`,
  };
}

function compareAgainstEntry(params: {
  address: string;
  implementationAddress: string;
  isProxy: boolean;
  reportedVersion?: string;
  versionSource?: 'onchain' | 'absent' | 'rpc_error';
  code: string;
  manifest: BytecodeManifest;
  contractName: string;
  expectedContractName?: string;
}): BytecodeComparison {
  const {
    address,
    implementationAddress,
    isProxy,
    reportedVersion,
    versionSource,
    code,
    manifest,
    contractName,
    expectedContractName,
  } = params;
  const entry = manifest.byName[contractName];
  assert(
    entry,
    `Missing manifest entry ${contractName} for ${manifest.packageVersion}`,
  );

  const onchainMaskedHash = computeMaskedRuntimeHash(
    code,
    entry.immutableRanges,
    entry.linkRanges,
  );
  const isMatch = onchainMaskedHash === entry.maskedRuntimeHash;
  const versionNote =
    reportedVersion && reportedVersion !== manifest.packageVersion
      ? `reported version ${reportedVersion} differs from matched package version ${manifest.packageVersion}`
      : undefined;
  return {
    address: utils.getAddress(address),
    implementationAddress,
    isProxy,
    onchainVersion: reportedVersion,
    reportedVersion,
    matchedPackageVersion: isMatch ? manifest.packageVersion : undefined,
    versionSource,
    validity: isMatch ? BytecodeValidity.Match : BytecodeValidity.Mismatch,
    expectedContractName,
    matchedContractName: isMatch ? contractName : undefined,
    onchainMaskedHash,
    expectedHash: entry.maskedRuntimeHash,
    note: isMatch ? versionNote : undefined,
  };
}

function mismatchComparison(params: {
  address: string;
  implementationAddress: string;
  isProxy: boolean;
  code: string;
  manifestSet: BytecodeManifestSet;
  reportedVersion?: string;
  versionSource?: 'onchain' | 'absent' | 'rpc_error';
  note: string;
  expectedContractName?: string;
}): BytecodeComparison {
  const manifest = Object.values(params.manifestSet)[0];
  const firstEntry = manifest ? Object.values(manifest.byName)[0] : undefined;
  const onchainMaskedHash = firstEntry
    ? computeMaskedRuntimeHash(
        params.code,
        firstEntry.immutableRanges,
        firstEntry.linkRanges,
      )
    : computeMaskedRuntimeHash(params.code, [], []);

  return {
    address: utils.getAddress(params.address),
    implementationAddress: params.implementationAddress,
    isProxy: params.isProxy,
    onchainVersion: params.reportedVersion,
    reportedVersion: params.reportedVersion,
    versionSource: params.versionSource,
    validity: BytecodeValidity.Mismatch,
    expectedContractName: params.expectedContractName,
    onchainMaskedHash,
    note: params.note,
  };
}

function orderedManifests(
  manifestSet: BytecodeManifestSet,
  reportedVersion?: string,
): BytecodeManifest[] {
  const manifests: BytecodeManifest[] = [];
  const reportedManifest = reportedVersion
    ? manifestSet[reportedVersion]
    : undefined;
  if (reportedManifest) manifests.push(reportedManifest);
  for (const [version, manifest] of Object.entries(manifestSet)) {
    if (version !== reportedVersion) manifests.push(manifest);
  }
  return manifests;
}

function findComparisonAcrossManifests(params: {
  address: string;
  implementationAddress: string;
  isProxy: boolean;
  code: string;
  manifestSet: BytecodeManifestSet;
  reportedVersion?: string;
  versionSource?: 'onchain' | 'absent' | 'rpc_error';
  expectedContractName?: string;
  approvedContractNames?: Set<string>;
}): BytecodeComparison | undefined {
  for (const manifest of orderedManifests(
    params.manifestSet,
    params.reportedVersion,
  )) {
    for (const contractName of Object.keys(manifest.byName)) {
      if (
        params.approvedContractNames &&
        !params.approvedContractNames.has(contractName)
      ) {
        continue;
      }
      if (!manifest.byName[contractName]) continue;
      const comparison = compareAgainstEntry({
        address: params.address,
        implementationAddress: params.implementationAddress,
        isProxy: params.isProxy,
        code: params.code,
        manifest,
        contractName,
        reportedVersion: params.reportedVersion,
        versionSource: params.versionSource,
        expectedContractName: params.expectedContractName,
      });
      if (comparison.validity === BytecodeValidity.Match) return comparison;
    }
  }
  return undefined;
}

function proxyContractNames(manifestSet: BytecodeManifestSet): Set<string> {
  const names = new Set<string>();
  for (const manifest of Object.values(manifestSet)) {
    for (const contractName of Object.keys(manifest.byName)) {
      if (contractName.endsWith('Proxy')) names.add(contractName);
    }
  }
  return names;
}

async function compareProxyRuntime(params: {
  provider: providers.Provider;
  address: string;
  implementationAddress: string;
  manifestSet: BytecodeManifestSet;
  reportedVersion?: string;
  versionSource: 'onchain' | 'absent' | 'rpc_error';
}): Promise<
  Pick<BytecodeComparison, 'proxyValidity' | 'proxyMatchedContractName'>
> {
  const proxyCode = await params.provider.getCode(params.address);
  if (proxyCode === '0x') return { proxyValidity: BytecodeValidity.NoCode };

  const matched = findComparisonAcrossManifests({
    address: params.address,
    implementationAddress: params.implementationAddress,
    isProxy: true,
    code: proxyCode,
    manifestSet: params.manifestSet,
    reportedVersion: params.reportedVersion,
    versionSource: params.versionSource,
    approvedContractNames: proxyContractNames(params.manifestSet),
  });

  return {
    proxyValidity: matched ? BytecodeValidity.Match : BytecodeValidity.Mismatch,
    proxyMatchedContractName: matched?.matchedContractName,
  };
}

function versionUnavailableNote(read: PackageVersionRead): string {
  if (read.kind === 'version') {
    return `reportedVersion ${read.version} is uncovered and no manifest hash matched.`;
  }
  if (read.kind === 'rpc_error') {
    return 'reportedVersion unavailable due to rpc_error and no manifest hash matched.';
  }
  return 'reportedVersion absent and no manifest hash matched.';
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

  const proxyVersionRead = await readOnchainPackageVersion(provider, address);
  const versionRead =
    isProxy && proxyVersionRead.kind === 'absent'
      ? await readOnchainPackageVersion(provider, implementationAddress)
      : proxyVersionRead;
  const reportedVersion =
    versionRead.kind === 'version' ? versionRead.version : undefined;
  const versionSource =
    versionRead.kind === 'version' ? 'onchain' : versionRead.kind;

  const matched = findComparisonAcrossManifests({
    address,
    implementationAddress,
    isProxy,
    code,
    manifestSet,
    reportedVersion,
    versionSource,
    expectedContractName: opts?.expectedContractName,
  });

  let comparison: BytecodeComparison;
  if (matched) {
    comparison = matched;
  } else if (reportedVersion && manifestSet[reportedVersion]) {
    comparison = mismatchComparison({
      address,
      implementationAddress,
      isProxy,
      code,
      manifestSet,
      reportedVersion,
      versionSource,
      expectedContractName: opts?.expectedContractName,
      note: `reportedVersion ${reportedVersion} is covered but no manifest hash matched.`,
    });
  } else {
    comparison = versionUnavailableComparison({
      address,
      implementationAddress,
      isProxy,
      reportedVersion,
      versionSource,
      manifestSet,
      note: versionUnavailableNote(versionRead),
    });
  }

  if (!isProxy) return comparison;

  const proxyComparison = await compareProxyRuntime({
    provider,
    address,
    implementationAddress,
    manifestSet,
    reportedVersion,
    versionSource,
  });
  if (proxyComparison.proxyValidity === BytecodeValidity.Match) {
    return { ...comparison, ...proxyComparison };
  }

  return {
    ...comparison,
    ...proxyComparison,
    validity: BytecodeValidity.Mismatch,
    note: 'proxy runtime is not a canonical Hyperlane/OZ proxy',
  };
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
