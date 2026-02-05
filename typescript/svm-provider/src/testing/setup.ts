import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs';
// eslint-disable-next-line import/no-nodejs-modules
import * as path from 'path';

import { deployProgram } from '../deploy/program-deployer.js';
import type { SvmSigner } from '../signer.js';
import type { SvmProgramAddresses, SvmReceipt } from '../types.js';

import type { PreloadedProgram } from './solana-container.js';

/**
 * Find the monorepo root by looking for pnpm-workspace.yaml.
 */
function findMonorepoRoot(): string {
  let dir = process.cwd();
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback to cwd if not found
  return process.cwd();
}

/**
 * Default path to Hyperlane Sealevel program binaries.
 * Resolved relative to the monorepo root.
 */
export const DEFAULT_PROGRAMS_PATH = path.join(
  findMonorepoRoot(),
  'rust/sealevel/target/deploy',
);

/**
 * Fixed program IDs for testing. These are deterministic addresses
 * derived from sha256("hyperlane-test-{program}") seeds, used with
 * --bpf-program to preload programs at validator startup.
 */
export const TEST_PROGRAM_IDS = {
  mailbox: '2Zvzyv2sstAhs9wu1xaLpH5X17dVouEb8zjkBRPKsSy5' as Address,
  igp: 'GZGLpeuMaUXUmBHh1EtgWQDufyUoHapAKFfgKb6u8o3h' as Address,
  multisigIsm: 'EALSQwzJFwRbjDjBkwNziHXnowfgwt9ixKapKiudGa45' as Address,
  testIsm: '2nss3sLwiUCP98rXQ6FciJ35cDeSLu3VEU5mFRa7p43J' as Address,
  validatorAnnounce: '4ZiKsHnTUbgH97sMggds4NfV31yBB3hsJJEKk1Fj8NyL' as Address,
} as const;

/**
 * Get preloaded program configurations for the test validator.
 * Programs are loaded at startup via --bpf-program, bypassing slow deployment.
 */
export function getPreloadedPrograms(
  programs: Array<keyof typeof PROGRAM_BINARIES>,
  programsPath: string = DEFAULT_PROGRAMS_PATH,
): PreloadedProgram[] {
  return programs.map((program) => ({
    programId: TEST_PROGRAM_IDS[program as keyof typeof TEST_PROGRAM_IDS],
    soPath: path.join(programsPath, PROGRAM_BINARIES[program]),
  }));
}

/**
 * Get program addresses for preloaded programs.
 */
export function getPreloadedProgramAddresses(
  programs: Array<keyof typeof PROGRAM_BINARIES>,
): SvmProgramAddresses {
  return {
    mailbox: programs.includes('mailbox')
      ? TEST_PROGRAM_IDS.mailbox
      : ('' as Address),
    igp: programs.includes('igp') ? TEST_PROGRAM_IDS.igp : ('' as Address),
    multisigIsm: programs.includes('multisigIsm')
      ? TEST_PROGRAM_IDS.multisigIsm
      : ('' as Address),
    testIsm: programs.includes('testIsm')
      ? TEST_PROGRAM_IDS.testIsm
      : ('' as Address),
  };
}

/**
 * Program binary filenames for each Hyperlane Sealevel program.
 */
export const PROGRAM_BINARIES = {
  mailbox: 'hyperlane_sealevel_mailbox.so',
  igp: 'hyperlane_sealevel_igp.so',
  multisigIsm: 'hyperlane_sealevel_multisig_ism_message_id.so',
  testIsm: 'hyperlane_sealevel_test_ism.so',
  validatorAnnounce: 'hyperlane_sealevel_validator_announce.so',
  token: 'hyperlane_sealevel_token.so',
  tokenNative: 'hyperlane_sealevel_token_native.so',
  tokenCollateral: 'hyperlane_sealevel_token_collateral.so',
} as const;

/**
 * Result from deploying Hyperlane programs.
 */
export interface DeployHyperlaneProgramsResult {
  /** Deployed program addresses */
  addresses: SvmProgramAddresses;
  /** All deployment receipts */
  receipts: SvmReceipt[];
}

/**
 * Configuration for deploying Hyperlane programs.
 */
export interface DeployConfig {
  /** Path to the directory containing .so files */
  programsPath?: string;
  /** Which programs to deploy (defaults to all core programs) */
  programs?: Array<keyof typeof PROGRAM_BINARIES>;
}

/**
 * Loads program bytes from a file path.
 * This is a Node.js-specific utility.
 */
async function loadProgramBytes(filePath: string): Promise<Uint8Array> {
  // Dynamic import to avoid bundling issues
  // eslint-disable-next-line import/no-nodejs-modules
  const fs = await import('fs/promises');
  const buffer = await fs.readFile(filePath);
  return new Uint8Array(buffer);
}

/**
 * Deploys Hyperlane Sealevel programs for testing.
 *
 * This function deploys the core Hyperlane programs (mailbox, IGP, ISMs)
 * to a local Solana validator for integration testing.
 *
 * @example
 * ```typescript
 * const solana = await startSolanaTestValidator();
 * const rpc = createRpc(solana.rpcUrl);
 * const signer = await createSigner(TEST_PRIVATE_KEY);
 *
 * const { addresses } = await deployHyperlanePrograms(rpc, signer, {
 *   programsPath: 'rust/sealevel/target/deploy',
 * });
 *
 * console.log('Mailbox:', addresses.mailbox);
 * console.log('IGP:', addresses.igp);
 * ```
 */
export async function deployHyperlanePrograms(
  rpc: Rpc<SolanaRpcApi>,
  signer: SvmSigner,
  config: DeployConfig = {},
): Promise<DeployHyperlaneProgramsResult> {
  const {
    programsPath = DEFAULT_PROGRAMS_PATH,
    programs = ['mailbox', 'igp', 'multisigIsm', 'testIsm'],
  } = config;

  const addresses: Partial<Record<keyof typeof PROGRAM_BINARIES, Address>> = {};
  const allReceipts: SvmReceipt[] = [];

  for (const program of programs) {
    const binaryPath = path.join(programsPath, PROGRAM_BINARIES[program]);

    // Load program bytes
    const programBytes = await loadProgramBytes(binaryPath);

    // Deploy program
    const result = await deployProgram({
      rpc,
      signer,
      programBytes,
    });

    addresses[program] = result.programId;
    allReceipts.push(...result.receipts);

    // eslint-disable-next-line no-console
    console.log(`Deployed ${program}: ${result.programId}`);
  }

  return {
    addresses: {
      mailbox: addresses.mailbox ?? ('' as Address),
      igp: addresses.igp ?? ('' as Address),
      multisigIsm: addresses.multisigIsm ?? ('' as Address),
      testIsm: addresses.testIsm ?? ('' as Address),
    },
    receipts: allReceipts,
  };
}

/**
 * Airdrops SOL to an account for testing.
 */
export async function airdropSol(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
  lamports: bigint = 10_000_000_000n, // 10 SOL
): Promise<void> {
  // Cast to any to handle Lamports nominal type
  const signature = await rpc.requestAirdrop(address, lamports as any).send();

  // Wait for confirmation
  let confirmed = false;
  for (let i = 0; i < 30 && !confirmed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await rpc.getSignatureStatuses([signature]).send();
    const result = status.value[0];
    if (
      result?.confirmationStatus === 'confirmed' ||
      result?.confirmationStatus === 'finalized'
    ) {
      confirmed = true;
    }
  }

  if (!confirmed) {
    throw new Error(`Airdrop not confirmed: ${signature}`);
  }
}

/**
 * Gets account balance in SOL.
 */
export async function getBalance(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<number> {
  const result = await rpc.getBalance(address).send();
  return Number(result.value) / 1_000_000_000; // Convert lamports to SOL
}
