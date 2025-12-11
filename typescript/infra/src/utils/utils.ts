// @ts-ignore
import asn1 from 'asn1.js';
import { exec } from 'child_process';
import { ethers } from 'ethers';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { ChainMap, ChainName, NativeToken } from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  objFilter,
  stringifyObject,
} from '@hyperlane-xyz/utils';
import { pathExists, readJson, writeToFile } from '@hyperlane-xyz/utils/fs';

import { Contexts } from '../../config/contexts.js';
import { testChainNames } from '../../config/environments/test/chains.js';
import { getChain, getChains } from '../../config/registry.js';
import { FundableRole, Role } from '../roles.js';

export function include(condition: boolean, data: any) {
  return condition ? data : {};
}

const EcdsaPubKey = asn1.define('EcdsaPubKey', function (this: any) {
  // parsing this according to https://tools.ietf.org/html/rfc5480#section-2
  this.seq().obj(
    this.key('algo').seq().obj(this.key('a').objid(), this.key('b').objid()),
    this.key('pubKey').bitstr(),
  );
});

export function getEthereumAddress(publicKey: Buffer): string {
  // The public key is ASN1 encoded in a format according to
  // https://tools.ietf.org/html/rfc5480#section-2
  // I used https://lapo.it/asn1js to figure out how to parse this
  // and defined the schema in the EcdsaPubKey object
  const res = EcdsaPubKey.decode(publicKey, 'der');
  let pubKeyBuffer: Buffer = res.pubKey.data;

  // The public key starts with a 0x04 prefix that needs to be removed
  // more info: https://www.oreilly.com/library/view/mastering-ethereum/9781491971932/ch04.html
  pubKeyBuffer = pubKeyBuffer.slice(1, pubKeyBuffer.length);

  const address = ethers.utils.keccak256(pubKeyBuffer); // keccak256 hash of publicKey
  const EthAddr = `0x${address.slice(-40)}`; // take last 20 bytes as ethereum address
  return EthAddr;
}

export function execCmd(
  cmd: string | string[],
  execOptions: any = {},
  rejectWithOutput = false,
  pipeOutput = false,
): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    if (Array.isArray(cmd)) cmd = cmd.join(' ');

    if (process.env.VERBOSE === 'true') {
      console.debug('$ ' + cmd);
      pipeOutput = true;
    }

    const execProcess = exec(
      cmd,
      { maxBuffer: 1024 * 10000, ...execOptions },
      (err, stdout, stderr) => {
        if (process.env.VERBOSE === 'true') {
          console.debug(stdout.toString());
        }
        if (err || process.env.VERBOSE === 'true') {
          console.error(stderr.toString());
        }
        if (err) {
          if (rejectWithOutput) {
            reject([err, stdout.toString(), stderr.toString()]);
          } else {
            reject(err);
          }
        } else {
          resolve([stdout.toString(), stderr.toString()]);
        }
      },
    );

    if (pipeOutput) {
      if (execProcess.stdout) {
        execProcess.stdout.pipe(process.stdout);
      }
      if (execProcess.stderr) {
        execProcess.stderr.pipe(process.stderr);
      }
    }
  });
}

export async function execCmdAndParseJson(
  cmd: string,
  execOptions: any = {},
  rejectWithOutput = false,
  pipeOutput = false,
) {
  const [stdout] = await execCmd(
    cmd,
    execOptions,
    rejectWithOutput,
    pipeOutput,
  );
  return JSON.parse(stdout);
}

export function includeConditionally(condition: boolean, data: any) {
  return condition ? data : {};
}

export function log(isTest: boolean, str: string) {
  if (!isTest) {
    console.log(str);
  }
}

export function warn(text: string, padded = false) {
  if (padded) {
    const padding = '*'.repeat(text.length + 8);
    console.log(
      `
      ${padding}
      *** ${text.toUpperCase()} ***
      ${padding}
      `,
    );
  } else {
    console.log(`**** ${text.toUpperCase()} ****`);
  }
}

/**
 * Writes a JSON file using stringifyObject for consistent formatting.
 * Use this for infra-specific JSON output that needs consistent formatting.
 */
export function writeJsonAtPath(filepath: string, obj: any) {
  const content = stringifyObject(obj, 'json', 2);
  writeToFile(filepath, content);
}

export async function writeAndFormatJsonAtPath(filepath: string, obj: any) {
  writeJsonAtPath(filepath, obj);
  await formatFileWithPrettier(filepath);
}

/**
 * Write JSON to file, optionally preserving existing values for keys.
 * If appendMode is true, keeps values from existingData for existing keys, adds new keys from newData.
 */
export async function writeJsonWithAppendMode(
  filepath: string,
  newData: Record<string, any>,
  appendMode: boolean,
) {
  let data = newData;
  if (appendMode && pathExists(filepath)) {
    const existing = readJson<Record<string, any>>(filepath);
    data = Object.fromEntries(
      Object.keys(newData).map((key) => [key, existing[key] ?? newData[key]]),
    );
  }
  await writeAndFormatJsonAtPath(filepath, data);
}

/**
 * Gets the monorepo root directory
 */
export function getMonorepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../../../');
}

/**
 * Formats a file using prettier
 * @param filepath - The path to the file to format
 */
export async function formatFileWithPrettier(filepath: string): Promise<void> {
  try {
    const monorepoRoot = getMonorepoRoot();
    await execCmd(`npx prettier --write "${filepath}"`, {
      cwd: monorepoRoot,
      stdio: 'pipe',
    });
  } catch (error) {
    // Silently fail if prettier is not available or fails
    // This ensures the deployment process continues even if formatting fails
    console.warn(
      `Warning: Failed to format file with prettier: ${filepath}`,
      error instanceof Error ? error.message : error,
    );
  }
}

export function assertRole(roleStr: string) {
  const role = roleStr as Role;
  if (!Object.values(Role).includes(role)) {
    throw Error(`Invalid role ${role}`);
  }
  return role;
}

export function assertFundableRole(roleStr: string): FundableRole {
  const role = roleStr as Role;
  if (
    role !== Role.Relayer &&
    role !== Role.Kathy &&
    role !== Role.Rebalancer
  ) {
    throw Error(`Invalid fundable role ${role}`);
  }
  return role;
}

export function assertChain(chain: ChainName) {
  if (!getChains().includes(chain) && !testChainNames.includes(chain)) {
    throw Error(`Invalid chain ${chain}`);
  }
  return chain;
}

export function assertContext(contextStr: string): Contexts {
  const context = contextStr as Contexts;
  if (Object.values(Contexts).includes(context)) {
    return context;
  }
  throw new Error(
    `Invalid context ${contextStr}, must be one of ${Object.values(
      Contexts,
    )}. ${
      contextStr === undefined ? ' Did you specify --context <context>?' : ''
    }`,
  );
}

/**
 * Converts a matrix to 1d array ordered by diagonals. This is useful if you
 * want to make sure that the order operations are performed in are ordered but
 * not repeating the same values from the inner or outer array in sequence.
 *
 * @warn Requires a square matrix.
 *
 * // 0,0 1,0 2,0 3,0
 * //
 * // 0,1 1,1 2,1 3,1
 * //
 * // 0,2 1,2 2,2 3,2
 * //
 * // 0,3 1,3 2,3 3,3
 *
 * becomes
 *
 * 0,0; 1,0; 0,1; 2,0; 1,1; 0,2; 3,0; 2,1; 1,2; 0,3; 3,1; 2,2; 1,3; 3,2; 2,3; 3,3
 *
 * Adapted from
 * https://www.geeksforgeeks.org/zigzag-or-diagonal-traversal-of-matrix/
 */
export function diagonalize<T>(array: Array<Array<T>>): Array<T> {
  const diagonalized: T[] = [];
  for (let line = 1; line <= array.length * 2; ++line) {
    const start_col = Math.max(0, line - array.length);
    const count = Math.min(line, array.length - start_col, array.length);
    for (let j = 0; j < count; ++j) {
      const k = Math.min(array.length, line) - j - 1;
      const l = start_col + j;
      diagonalized.push(array[k][l]);
    }
  }
  return diagonalized;
}

export function mustGetChainNativeToken(chain: ChainName): NativeToken {
  const metadata = getChain(chain);
  if (!metadata.nativeToken) {
    throw new Error(`No native token for chain ${chain}`);
  }
  return metadata.nativeToken;
}

export function chainIsProtocol(chainName: ChainName, protocol: ProtocolType) {
  if (!getChain(chainName)) throw new Error(`Unknown chain ${chainName}`);
  return getChain(chainName).protocol === protocol;
}

export function isEthereumProtocolChain(chainName: ChainName) {
  return chainIsProtocol(chainName, ProtocolType.Ethereum);
}

export function getInfraPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '../../');
}

// Filter out chains that are not supported by the multiProvider
// Filter out any value that is not a string e.g. remote domain metadata
export function filterRemoteDomainMetadata(
  addressesMap: ChainMap<Record<string, Address>>,
): ChainMap<Record<string, Address>> {
  return Object.fromEntries(
    Object.entries(addressesMap).map(([chain, addresses]) => [
      chain,
      // Filter out any non-string writes
      // e.g. remote domain metadata that might be present
      objFilter(
        addresses,
        (_, value): value is string => typeof value === 'string',
      ),
    ]),
  );
}
