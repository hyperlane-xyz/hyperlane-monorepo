// Node-only: manifest generation reads solc build-info from disk.
// eslint-disable-next-line import/no-nodejs-modules
import fs from 'fs';
// eslint-disable-next-line import/no-nodejs-modules
import path from 'path';

import { utils } from 'ethers';

import { assert, rootLogger } from '@hyperlane-xyz/utils';

const logger = rootLogger.child({ module: 'bytecodeManifest' });

export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export interface ByteRange {
  start: number;
  length: number;
}

export interface ContractBytecodeEntry {
  contractName: string;
  sourcePath: string;
  packageVersion: string;
  immutableRanges: ByteRange[];
  linkRanges: ByteRange[];
  maskedRuntimeHash: string;
}

export interface BytecodeManifest {
  packageVersion: string;
  byName: Record<string, ContractBytecodeEntry>;
  byHash: Record<string, string[]>;
}

export type BytecodeManifestSet = Record<string, BytecodeManifest>;

interface BuildInfoDeployedBytecode {
  object?: string;
  immutableReferences?: Record<string, ByteRange[]>;
  linkReferences?: Record<string, Record<string, ByteRange[]>>;
}

interface BuildInfoContractOutput {
  evm?: {
    deployedBytecode?: BuildInfoDeployedBytecode;
  };
}

interface BuildInfo {
  output?: {
    contracts?: Record<string, Record<string, BuildInfoContractOutput>>;
  };
}

interface ManifestCandidate {
  entry: ContractBytecodeEntry;
  contractCount: number;
  buildInfoFile: string;
}

function normalizeHex(hexBytecode: string): string {
  return hexBytecode.replace(/^0x/i, '').toLowerCase();
}

export function stripMetadata(hexBytecode: string): string {
  const normalized = normalizeHex(hexBytecode);
  if (normalized.length < 4) return normalized;

  const byteLength = normalized.length / 2;
  const metadataLength = parseInt(normalized.slice(-4), 16);
  const totalMetadataLength = metadataLength + 2;
  if (
    metadataLength > byteLength ||
    totalMetadataLength > byteLength ||
    totalMetadataLength < 2
  ) {
    return normalized;
  }

  return normalized.slice(0, normalized.length - totalMetadataLength * 2);
}

export function maskRanges(
  hexBytecodeNo0x: string,
  ranges: ByteRange[],
): string {
  let masked = normalizeHex(hexBytecodeNo0x);
  for (const range of ranges) {
    assert(range.start >= 0, `Invalid byte range start ${range.start}`);
    assert(range.length >= 0, `Invalid byte range length ${range.length}`);

    const start = range.start * 2;
    const end = start + range.length * 2;
    if (start >= masked.length) continue;

    const boundedEnd = Math.min(end, masked.length);
    masked =
      masked.slice(0, start) +
      '0'.repeat(boundedEnd - start) +
      masked.slice(boundedEnd);
  }
  return masked;
}

export function computeMaskedRuntimeHash(
  deployedBytecodeHex: string,
  immutableRanges: ByteRange[],
  linkRanges: ByteRange[],
): string {
  const normalized = normalizeHex(deployedBytecodeHex);
  const masked = stripMetadata(
    maskRanges(normalized, [...immutableRanges, ...linkRanges]),
  );
  return utils.keccak256(`0x${masked}`);
}

export function flattenImmutableReferences(
  immutableReferences: Record<string, ByteRange[]> | undefined,
): ByteRange[] {
  if (!immutableReferences) return [];
  return Object.values(immutableReferences).flatMap((ranges) =>
    ranges.map(({ start, length }) => ({ start, length })),
  );
}

export function flattenLinkReferences(
  linkReferences: Record<string, Record<string, ByteRange[]>> | undefined,
): ByteRange[] {
  if (!linkReferences) return [];
  return Object.values(linkReferences).flatMap((libraryReferences) =>
    Object.values(libraryReferences).flatMap((ranges) =>
      ranges.map(({ start, length }) => ({ start, length })),
    ),
  );
}

function countContracts(buildInfo: BuildInfo): number {
  const contracts = buildInfo.output?.contracts;
  if (!contracts) return 0;
  return Object.values(contracts).reduce(
    (sum, sourceContracts) => sum + Object.keys(sourceContracts).length,
    0,
  );
}

function readBuildInfo(filePath: string): BuildInfo {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BuildInfo;
}

function addCandidate(
  candidates: Record<string, ManifestCandidate>,
  candidate: ManifestCandidate,
): void {
  const existing = candidates[candidate.entry.contractName];
  if (!existing) {
    candidates[candidate.entry.contractName] = candidate;
    return;
  }

  if (existing.entry.maskedRuntimeHash === candidate.entry.maskedRuntimeHash) {
    return;
  }

  const shouldReplace = candidate.contractCount > existing.contractCount;
  const selected = shouldReplace ? candidate : existing;
  logger.warn(
    [
      `Bytecode manifest hash collision for ${candidate.entry.contractName}.`,
      `Keeping ${selected.buildInfoFile} from larger build-info.`,
      `Skipped ${shouldReplace ? existing.buildInfoFile : candidate.buildInfoFile}.`,
    ].join(' '),
  );

  if (shouldReplace) {
    candidates[candidate.entry.contractName] = candidate;
  }
}

export function generateManifestFromBuildInfoDir(
  buildInfoDir: string,
  packageVersion: string,
): BytecodeManifest {
  const candidates: Record<string, ManifestCandidate> = {};
  const files = fs
    .readdirSync(buildInfoDir)
    .filter((file) => file.endsWith('.json'))
    .sort();

  for (const file of files) {
    const filePath = path.join(buildInfoDir, file);
    const buildInfo = readBuildInfo(filePath);
    const contractCount = countContracts(buildInfo);
    const contracts = buildInfo.output?.contracts;
    if (!contracts) continue;

    for (const [sourcePath, sourceContracts] of Object.entries(contracts)) {
      for (const [contractName, contract] of Object.entries(sourceContracts)) {
        const deployedBytecode = contract.evm?.deployedBytecode;
        const object = deployedBytecode?.object;
        if (!object || object === '0x') continue;

        const immutableRanges = flattenImmutableReferences(
          deployedBytecode.immutableReferences,
        );
        const linkRanges = flattenLinkReferences(
          deployedBytecode.linkReferences,
        );
        const entry: ContractBytecodeEntry = {
          contractName,
          sourcePath,
          packageVersion,
          immutableRanges,
          linkRanges,
          maskedRuntimeHash: computeMaskedRuntimeHash(
            object,
            immutableRanges,
            linkRanges,
          ),
        };

        addCandidate(candidates, {
          entry,
          contractCount,
          buildInfoFile: filePath,
        });
      }
    }
  }

  const byName = Object.fromEntries(
    Object.entries(candidates).map(([contractName, candidate]) => [
      contractName,
      candidate.entry,
    ]),
  );
  const byHash: Record<string, string[]> = {};
  for (const entry of Object.values(byName)) {
    byHash[entry.maskedRuntimeHash] ||= [];
    byHash[entry.maskedRuntimeHash].push(entry.contractName);
  }

  return {
    packageVersion,
    byName,
    byHash,
  };
}
