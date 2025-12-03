import { BHP256, Plaintext, Program, U128 } from '@provablehq/sdk/mainnet.js';

import { isValidAddressAleo, strip0x } from '@hyperlane-xyz/utils';

import { AleoProgram, programRegistry } from '../artifacts.js';

const upgradeAuthority = process.env['ALEO_UPGRADE_AUTHORITY'] || '';
const skipSuffixes = JSON.parse(process.env['ALEO_SKIP_SUFFIXES'] || 'false');
const customIsmSuffix = process.env['ALEO_ISM_MANAGER_SUFFIX'];
const customWarpSuffix = process.env['ALEO_WARP_SUFFIX'];

export function loadProgramsInDeployOrder(
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
              `${p1}_${customWarpSuffix || warpSuffix || coreSuffix}.aleo`,
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
    } else if (upgradeAuthority.split('/').length === 3) {
      const [program, mapping, key] = upgradeAuthority.split('/');

      programs = programs.map((p) =>
        Program.fromString(
          p.toString().includes(`constructor:
    assert.eq edition 0u16;`)
            ? `import ${program};\n` +
                p.toString().replaceAll(
                  `constructor:
    assert.eq edition 0u16;`,
                  `constructor:
    branch.eq edition 0u16 to end;
    get ${program}/${mapping}[${key}] into r0;
    assert.eq checksum r0;
    position end;`,
                )
            : p.toString(),
        ),
      );
    } else {
      throw new Error(
        `upgrade authority must be an aleo account address or of format "program.aleo/mapping/key"`,
      );
    }
  }

  return programs.map((p) => ({
    id: p.id(),
    name: Object.keys(programRegistry).find((r) => p.id().startsWith(r)) || '',
    program: p.toString(),
  }));
}

export const ALEO_NULL_ADDRESS =
  'aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc';
export const ALEO_NATIVE_DENOM = '0field';

export function formatAddress(address: string): string {
  return address === ALEO_NULL_ADDRESS ? '' : address;
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

  const [programId, address] = aleoAddress.split('/');

  return {
    programId,
    address,
  };
}

export function getProgramSuffix(address: string): string {
  let suffix = address;

  for (const key of Object.keys(programRegistry)) {
    suffix = suffix.replaceAll(key, '');
  }

  suffix = suffix.replaceAll('.aleo', '');
  suffix = suffix.replaceAll('_', '');

  return suffix;
}

export function getProgramIdFromSuffix(program: AleoProgram, suffix: string) {
  if (skipSuffixes || !suffix) {
    return `${program}.aleo`;
  }

  return `${program}_${suffix}.aleo`;
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
