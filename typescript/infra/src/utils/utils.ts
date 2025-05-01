// @ts-ignore
import asn1 from 'asn1.js';
import { exec } from 'child_process';
import { ethers } from 'ethers';
// eslint-disable-next-line
import fs from 'fs';
import path, { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse as yamlParse } from 'yaml';

import { ChainMap, ChainName, NativeToken } from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  objFilter,
  objMerge,
  stringifyObject,
} from '@hyperlane-xyz/utils';

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

export function writeMergedJSONAtPath(filepath: string, obj: any) {
  if (fs.existsSync(filepath)) {
    const previous = readJSONAtPath(filepath);
    writeJsonAtPath(filepath, objMerge(previous, obj));
  } else {
    writeJsonAtPath(filepath, obj);
  }
}

export function writeMergedJSON(directory: string, filename: string, obj: any) {
  writeMergedJSONAtPath(path.join(directory, filename), obj);
}

function ensureDirectoryExists(filepath: string) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeToFile(filepath: string, content: string) {
  ensureDirectoryExists(filepath);
  fs.writeFileSync(filepath, content + '\n');
}

export function writeJsonAtPath(filepath: string, obj: any) {
  const content = stringifyObject(obj, 'json', 2);
  writeToFile(filepath, content);
}

export function writeYamlAtPath(filepath: string, obj: any) {
  const content = stringifyObject(obj, 'yaml', 2);
  writeToFile(filepath, content);
}

export function writeJSON(directory: string, filename: string, obj: any) {
  writeJsonAtPath(path.join(directory, filename), obj);
}

export function readFileAtPath(filepath: string) {
  if (!fs.existsSync(filepath)) {
    throw Error(`file doesn't exist at ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf8');
}

export function readJSONAtPath(filepath: string) {
  return JSON.parse(readFileAtPath(filepath));
}

export function readJSON(directory: string, filename: string) {
  return readJSONAtPath(path.join(directory, filename));
}

export function readYaml<T>(filepath: string): T {
  return yamlParse(readFileAtPath(filepath)) as T;
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
  if (role !== Role.Relayer && role !== Role.Kathy) {
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
