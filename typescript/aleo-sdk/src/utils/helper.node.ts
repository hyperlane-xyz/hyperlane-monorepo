import { readFileSync } from 'fs';

import { Program } from '@provablehq/sdk/mainnet.js';

import { assert } from '@hyperlane-xyz/utils';

import { type AleoProgram, programRegistry } from '../artifacts.js';

const upgradeAuthority = process.env['ALEO_UPGRADE_AUTHORITY'] || '';
const skipSuffixes = JSON.parse(process.env['ALEO_SKIP_SUFFIXES'] || 'false');
const customIsmSuffix = process.env['ALEO_ISM_MANAGER_SUFFIX'];

// Env vars that point to pre-built .aleo files to deploy verbatim
export const PROGRAM_FILE_ENV: Partial<Record<AleoProgram, string>> = {
  credits: 'ALEO_CREDITS',
  dispatch_proxy: 'ALEO_DISPATCH_PROXY',
  hook_manager: 'ALEO_HOOK_MANAGER',
  hyp_collateral: 'ALEO_HYP_COLLATERAL',
  hyp_native: 'ALEO_HYP_NATIVE',
  hyp_synthetic: 'ALEO_HYP_SYNTHETIC',
  ism_manager: 'ALEO_ISM_MANAGER',
  mailbox: 'ALEO_MAILBOX',
  token_registry: 'ALEO_TOKEN_REGISTRY',
  validator_announce: 'ALEO_VALIDATOR_ANNOUNCE',
};

function readFileOverride(
  programName: AleoProgram,
): { id: string; program: string } | undefined {
  const envVar = PROGRAM_FILE_ENV[programName];
  if (!envVar) return undefined;
  const filePath = process.env[envVar];
  if (!filePath) return undefined;
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/^program ([a-z0-9_]+\.aleo);/m);
  assert(
    match,
    `Could not find program declaration in override file ${filePath}`,
  );
  const id = match[1];
  try {
    Program.fromString(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Invalid Aleo program in override file ${filePath} (${id}): ${msg}`,
    );
  }
  return { id, program: content };
}

export function getFileOverrideProgramId(
  programName: AleoProgram,
): string | undefined {
  return readFileOverride(programName)?.id;
}

function getCustomWarpSuffixFromEnv(): string | undefined {
  return process.env['ALEO_WARP_SUFFIX'];
}

export function loadProgramsInDeployOrder(
  prefix: string,
  programName: AleoProgram,
  coreSuffix: string,
  warpSuffix?: string,
): { id: string; name: string; program: string }[] {
  // If a file override is set, deploy that file verbatim — no substitutions, no deps
  const override = readFileOverride(programName);
  if (override) {
    return [{ id: override.id, name: programName, program: override.program }];
  }

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
            (_, p1) => {
              if (p1 === 'hyp_native') {
                return `hyp_warp_token_credits.aleo`;
              }
              const effectiveSuffix =
                getCustomWarpSuffixFromEnv() || warpSuffix || coreSuffix;
              return `hyp_warp_token_${effectiveSuffix}.aleo`;
            },
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
      Object.keys(programRegistry).find((r) => {
        if (r === 'hyp_native') {
          return p.id() === `${prefix}_warp_token_credits.aleo`;
        }
        if (
          (r === 'hyp_collateral' || r === 'hyp_synthetic') &&
          r === programName &&
          p.id().startsWith(`${prefix}_warp_token_`) &&
          p.id() !== `${prefix}_warp_token_credits.aleo`
        ) {
          return true;
        }
        return p.id().startsWith(`${prefix}_${r.replaceAll('hyp_', '')}`);
      }) || '',
    program: p.toString(),
  }));
}
