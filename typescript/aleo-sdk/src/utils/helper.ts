import { BHP256, Plaintext, Program, U128 } from '@provablehq/sdk/mainnet.js';

import { TokenType } from '@hyperlane-xyz/provider-sdk/warp';
import {
  isValidAddressAleo,
  isZeroishAddress,
  strip0x,
} from '@hyperlane-xyz/utils';

import { type AleoProgram, programRegistry } from '../artifacts.js';

import { AleoTokenType } from './types.js';

const upgradeAuthority = process.env['ALEO_UPGRADE_AUTHORITY'] || '';
const skipSuffixes = JSON.parse(process.env['ALEO_SKIP_SUFFIXES'] || 'false');
const customIsmSuffix = process.env['ALEO_ISM_MANAGER_SUFFIX'];

function getCustomWarpSuffixFromEnv(): string | undefined {
  return process.env['ALEO_WARP_SUFFIX'];
}

export const MAINNET_PREFIX = 'hyp';
export const TESTNET_PREFIX = 'test_hyp';

export const RETRY_ATTEMPTS = 10;
export const RETRY_DELAY_MS = 100;

export const SUFFIX_LENGTH_LONG = 6;
export const SUFFIX_LENGTH_SHORT = 3;

export function loadProgramsInDeployOrder(
  prefix: string,
  programName: AleoProgram,
  coreSuffix: string,
  warpSuffix?: string,
): { id: string; name: string; program: string }[] {
  const visited = new Set<string>();
  let programs: Program[] = [];

  function visit(p: AleoProgram) {
    if (visited.has(p)) return;
    visited.add(p);

    const code = programRegistry[p];
    if (!code) throw new Error(`Program ${p} not found`);

    const program = Program.fromString(code);

    program
      .getImports()
      .map((dep) => dep.replace('.aleo', ''))
      .forEach((dep) => visit(dep));

    programs.push(program);
  }

  visit(programName);

  programs = programs.map((p) => {
    let output = p.toString();

    for (const r of Object.keys(programRegistry)) {
      if (r === 'credits' || r === 'token_registry') {
        continue;
      }

      output = output.replaceAll(
        `${r}.aleo`,
        `${prefix}_${r.replaceAll('hyp_', '')}.aleo`,
      );
    }

    return Program.fromString(output);
  });

  if (!skipSuffixes) {
    programs = programs.map((p) =>
      Program.fromString(
        p
          .toString()
          .replaceAll(
            /(mailbox|hook_manager|dispatch_proxy|validator_announce).aleo/g,
            (_, p1) => (coreSuffix ? `${p1}_${coreSuffix}.aleo` : `${p1}.aleo`),
          )
          .replaceAll(
            /(hyp_native|hyp_collateral|hyp_synthetic).aleo/g,
            (_, p1) =>
              `${p1}_${getCustomWarpSuffixFromEnv() || warpSuffix || coreSuffix}.aleo`,
          ),
      ),
    );

    if (customIsmSuffix) {
      programs = programs.map((p) =>
        Program.fromString(
          p
            .toString()
            .replaceAll(
              'ism_manager.aleo',
              `ism_manager_${customIsmSuffix}.aleo`,
            ),
        ),
      );
    }
  }

  if (upgradeAuthority) {
    if (new RegExp(/^(aleo1[a-z0-9]{58})$/).test(upgradeAuthority)) {
      programs = programs.map((p) =>
        Program.fromString(
          p.toString().replaceAll(
            `constructor:
    assert.eq edition 0u16;`,
            `constructor:
    assert.eq program_owner ${upgradeAuthority};`,
          ),
        ),
      );
    } else if (new RegExp(/^[a-z0-9_]+\.aleo$/).test(upgradeAuthority)) {
      programs = programs.map((p) =>
        Program.fromString(
          `import ${upgradeAuthority};\n` +
            p.toString().replaceAll(
              `constructor:
    assert.eq edition 0u16;`,
              `struct ChecksumEdition:
    checksum as [u8; 32u32];
    edition as u16;

struct WalletEcdsaSigner:
    wallet_id as address;
    ecdsa_signer as [u8; 20u32];

struct WalletSigningOpId:
    wallet_id as address;
    signing_op_id as field;

struct AdminOp:
    op as u8;
    threshold as u8;
    aleo_signer as address;
    ecdsa_signer as [u8; 20u32];
    
constructor:
    gt edition 0u16 into r0;
    branch.eq r0 false to end_then_0_2;
    cast checksum edition into r1 as ChecksumEdition;
    hash.bhp256 r1 into r2 as field;
    cast ${p.id()} r2 into r3 as WalletSigningOpId;
    hash.bhp256 r3 into r4 as field;
    contains ${upgradeAuthority}/completed_signing_ops[r4] into r5;
    assert.eq r5 true;
    branch.eq true true to end_otherwise_0_3;
    position end_then_0_2;
    position end_otherwise_0_3;`,
            ),
        ),
      );
    } else {
      throw new Error(
        `upgrade authority must be an aleo account address or the program id of a multisig program`,
      );
    }
  }

  return programs.map((p) => ({
    id: p.id(),
    name:
      Object.keys(programRegistry).find((r) =>
        p.id().startsWith(`${prefix}_${r.replaceAll('hyp_', '')}`),
      ) || '',
    program: p.toString(),
  }));
}

export const ALEO_NULL_ADDRESS =
  'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc';
export const ALEO_NATIVE_DENOM = 'credits';

export function formatAddress(address: string): string {
  return isZeroishAddress(address) ? '' : address;
}

export function fillArray(array: any[], length: number, fillValue: any): any[] {
  return array.length < length
    ? [...array, ...Array(length - array.length).fill(fillValue)]
    : array.slice(0, length);
}

export function arrayToPlaintext(array: string[]): string {
  return `[${array.join(',')}]`;
}

export function programIdToPlaintext(programId: string): string {
  const bytes = Array.from(programId).map((c) => `${c.charCodeAt(0)}u8`);
  return arrayToPlaintext(fillArray(bytes, 128, `0u8`));
}

export function getAddressFromProgramId(programId: string): string {
  return Plaintext.fromString(programId).toString();
}

export function toAleoAddress(programId: string): string {
  return `${programId}/${getAddressFromProgramId(programId)}`;
}

export function fromAleoAddress(aleoAddress: string): {
  programId: string;
  address: string;
} {
  if (!isValidAddressAleo(aleoAddress)) {
    throw new Error(`address ${aleoAddress} is no valid aleo address`);
  }

  const [programId, address]: (string | undefined)[] = aleoAddress.split('/');

  // If address is not defined, then it means that the address
  // does not have a programId prefix but it is still a valid aleo address
  // because it passed validation
  if (!address) {
    return {
      // FIXME, change this function return type signature to make it explicit
      // that the programId might not be found
      programId: '',
      address: aleoAddress,
    };
  }

  // If address is not defined, then it means that the address
  // does not have a programId prefix but it is still a valid aleo address
  // because it passed validation
  if (!address) {
    return {
      programId: aleoAddress,
      address: aleoAddress,
    };
  }

  return {
    programId,
    address,
  };
}

export function getProgramSuffix(address: string): string {
  let suffix = address;

  for (const prefix of [`${TESTNET_PREFIX}_`, `${MAINNET_PREFIX}_`]) {
    suffix = suffix.replaceAll(prefix, '');
  }

  for (const key of Object.keys(programRegistry)) {
    suffix = suffix.replaceAll(key, '');
  }

  suffix = suffix.replaceAll('.aleo', '');
  suffix = suffix.replaceAll('_', '');

  return suffix;
}

export function getProgramIdFromSuffix(
  prefix: string,
  program: AleoProgram,
  suffix: string,
) {
  if (skipSuffixes || !suffix) {
    return `${prefix}_${program}.aleo`;
  }

  return `${prefix}_${program}_${suffix}.aleo`;
}

export function stringToU128(str: string, littleEndian = false): bigint {
  if (str.length > 16) {
    throw new RangeError('String must not exceed 16 bytes for u128');
  }

  const inputBytes = Uint8Array.from(str, (c) => c.charCodeAt(0));

  const bytes = new Uint8Array(16);
  bytes.set(inputBytes, 0);

  let value = 0n;
  if (!littleEndian) {
    for (let i = 0; i < 16; i++) {
      value = (value << 8n) | BigInt(bytes[i]);
    }
  } else {
    for (let i = 15; i >= 0; i--) {
      value = (value << 8n) | BigInt(bytes[i]);
    }
  }

  return value;
}

export function U128ToString(value: bigint, littleEndian = false): string {
  if (value < 0n || value >= 1n << 128n) {
    throw new RangeError('Value out of range for u128');
  }

  const bytes = new Uint8Array(16);
  let temp = value;

  for (let i = 0; i < 16; i++) {
    const byte = Number(temp & 0xffn);
    bytes[littleEndian ? i : 15 - i] = byte;
    temp >>= 8n;
  }

  return String.fromCharCode(...bytes.filter((b) => b > 0));
}

export function bytes32ToU128String(input: string): string {
  const bytes = Buffer.from(strip0x(input), 'hex');

  // Split into two 128-bit chunks
  const lowBytes = Uint8Array.from(bytes.subarray(0, 16));
  const highBytes = Uint8Array.from(bytes.subarray(16, 32));

  return `[${U128.fromBytesLe(lowBytes).toString()},${U128.fromBytesLe(highBytes).toString()}]`;
}

export function getBalanceKey(address: string, denom: string): string {
  return new BHP256()
    .hash(
      Plaintext.fromString(`{account:${address},token_id:${denom}}`).toBitsLe(),
    )
    .toString();
}

/**
 * Convert AleoTokenType to provider-sdk TokenType
 */
export function aleoTokenTypeToWarpType(aleoType: AleoTokenType): TokenType {
  switch (aleoType) {
    case AleoTokenType.NATIVE:
      return TokenType.native;
    case AleoTokenType.SYNTHETIC:
      return TokenType.synthetic;
    case AleoTokenType.COLLATERAL:
      return TokenType.collateral;
    default:
      throw new Error(`Unknown AleoTokenType: ${aleoType}`);
  }
}

/**
 * Generate a random suffix of length n using alphanumeric characters
 */
export function generateSuffix(n: number): string {
  const characters = '0123456789abcdefghijklmnopqrstuvwxyz';
  let result = '';

  for (let i = 0; i < n; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    result += characters[randomIndex];
  }

  return result;
}
