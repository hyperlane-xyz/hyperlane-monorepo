import { Program } from '@provablehq/sdk/mainnet.js';

import { programRegistry } from '../artifacts.js';

const upgradeAuthority = process.env['ALEO_UPGRADE_AUTHORITY'] || '';
const originalProgramIds = JSON.parse(
  process.env['ALEO_USE_ORIGINAL_PROGRAM_IDS'] || 'false',
);

export function loadProgramsInDeployOrder(
  programName: string,
  coreSalt: string,
  warpSalt?: string,
): { id: string; program: string }[] {
  const visited = new Set<string>();
  let programs: Program[] = [];

  function visit(p: string) {
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

  if (!originalProgramIds) {
    programs = programs.map((p) =>
      Program.fromString(
        p
          .toString()
          .replaceAll(
            /(mailbox|hook_manager|dispatch_proxy|validator_announce).aleo/g,
            (_, p1) => `${p1}_${coreSalt}.aleo`,
          )
          .replaceAll(
            /(hyp_native|hyp_collateral|hyp_synthetic).aleo/g,
            (_, p1) => `${p1}_${warpSalt || coreSalt}.aleo`,
          ),
      ),
    );
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
