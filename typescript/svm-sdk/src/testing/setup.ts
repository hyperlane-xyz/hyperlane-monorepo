import { getCreateAccountInstruction } from '@solana-program/system';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import {
  lamports as brandLamports,
  generateKeyPairSigner,
  getAddressEncoder,
} from '@solana/kit';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs';
// eslint-disable-next-line import/no-nodejs-modules
import * as os from 'os';
// eslint-disable-next-line import/no-nodejs-modules
import * as path from 'path';

import { assert, retryAsync } from '@hyperlane-xyz/utils';
import type { SvmSigner } from '../clients/signer.js';
import {
  SPL_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../constants.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { buildInstruction, writableAccount } from '../instructions/utils.js';
import type { SvmRpc } from '../types.js';

import type { PreloadedProgram } from './solana-container.js';

export const TEST_PROGRAM_IDS = {
  mailbox: '2Zvzyv2sstAhs9wu1xaLpH5X17dVouEb8zjkBRPKsSy5' as Address,
  igp: 'GZGLpeuMaUXUmBHh1EtgWQDufyUoHapAKFfgKb6u8o3h' as Address,
  multisigIsm: 'EALSQwzJFwRbjDjBkwNziHXnowfgwt9ixKapKiudGa45' as Address,
  testIsm: '2nss3sLwiUCP98rXQ6FciJ35cDeSLu3VEU5mFRa7p43J' as Address,
  validatorAnnounce: '4ZiKsHnTUbgH97sMggds4NfV31yBB3hsJJEKk1Fj8NyL' as Address,
} as const;

export const TEST_ATA_PAYER_FUNDING_AMOUNT = 100_000_000n;

export const PROGRAM_BINARIES = {
  mailbox: 'hyperlane_sealevel_mailbox.so',
  igp: 'hyperlane_sealevel_igp.so',
  multisigIsm: 'hyperlane_sealevel_multisig_ism_message_id.so',
  testIsm: 'hyperlane_sealevel_test_ism.so',
  validatorAnnounce: 'hyperlane_sealevel_validator_announce.so',
  tokenSynthetic: 'hyperlane_sealevel_token.so',
  tokenNative: 'hyperlane_sealevel_token_native.so',
  tokenCollateral: 'hyperlane_sealevel_token_collateral.so',
} as const;

export type PreloadableProgram = keyof typeof PROGRAM_BINARIES &
  keyof typeof TEST_PROGRAM_IDS;

// Token-2022 v10.0.0 binary — fixes InvalidRealloc on Agave v3.0+ where the
// stricter_abi_and_runtime_constraints feature gate rejects the older program's
// non-zero-init realloc calls during InitializeTokenMetadata.
// See https://github.com/anza-xyz/agave/issues/9799
// Binary source: https://github.com/solana-program/token-2022/releases/tag/program%40v10.0.0
const TOKEN_2022_V10_SO_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'fixtures',
  'spl_token_2022_v10.so',
);

/**
 * Writes embedded program bytes to temp .so files for the test validator.
 * The solana-test-validator CLI requires file paths for --bpf-program,
 * so we materialize the embedded Uint8Array bytes to disk.
 *
 * Returns the programs array and a cleanup function to remove the temp dir.
 */
export function getPreloadedPrograms(programs: Array<PreloadableProgram>): {
  programs: PreloadedProgram[];
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svm-programs-'));

  const preloaded = programs.map((program) => {
    const programId = TEST_PROGRAM_IDS[program];
    assert(programId, `Program '${program}' not found in TEST_PROGRAM_IDS`);

    const bytes = HYPERLANE_SVM_PROGRAM_BYTES[program];
    assert(
      bytes,
      `Program '${program}' not found in HYPERLANE_SVM_PROGRAM_BYTES`,
    );

    const soPath = path.join(tmpDir, PROGRAM_BINARIES[program]);
    fs.writeFileSync(soPath, bytes);

    return { programId, soPath };
  });

  // Override the built-in Token-2022 with v10.0.0 to fix realloc on v3.0+.
  // Copy to tmpDir so all .so files are in one directory for Docker bind-mount.
  assert(
    fs.existsSync(TOKEN_2022_V10_SO_PATH),
    `Token-2022 v10 fixture not found at ${TOKEN_2022_V10_SO_PATH}. ` +
      'Without it, Agave v3.0+ will fail with InvalidRealloc errors.',
  );
  const destPath = path.join(tmpDir, 'spl_token_2022_v10.so');
  fs.copyFileSync(TOKEN_2022_V10_SO_PATH, destPath);
  preloaded.push({
    programId: TOKEN_2022_PROGRAM_ADDRESS,
    soPath: destPath,
  });

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  };

  return { programs: preloaded, cleanup };
}

export async function airdropSol(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
  amount: bigint = 10_000_000_000n,
): Promise<void> {
  const signature = await retryAsync(() =>
    rpc.requestAirdrop(address, brandLamports(amount)).send(),
  );

  let confirmed = false;
  for (let i = 0; i < 30 && !confirmed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await rpc.getSignatureStatuses([signature]).send();
    const result = status.value[0];
    if (result && result.confirmationStatus) {
      if (result.err) {
        throw new Error(
          `Airdrop failed: ${signature}, err: ${JSON.stringify(result.err)}`,
        );
      }
      if (
        result.confirmationStatus === 'confirmed' ||
        result.confirmationStatus === 'finalized'
      ) {
        confirmed = true;
      }
    }
  }

  if (!confirmed) {
    throw new Error(`Airdrop not confirmed: ${signature}`);
  }
}

export async function getBalance(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<number> {
  const result = await rpc.getBalance(address).send();
  return Number(result.value) / 1_000_000_000;
}

/**
 * Creates a new SPL Token (v1) mint account using only @solana/kit primitives.
 * The signer becomes the mint authority. No freeze authority is set.
 */
export async function createSplMint(
  rpc: SvmRpc,
  signer: SvmSigner,
  decimals: number,
): Promise<Address> {
  /** SPL Token mint account size in bytes. */
  const MINT_SIZE = 82n;

  const mintSigner = await generateKeyPairSigner();
  const rent = await rpc.getMinimumBalanceForRentExemption(MINT_SIZE).send();

  const createAccountIx = getCreateAccountInstruction({
    payer: signer.signer,
    newAccount: mintSigner,
    lamports: rent,
    space: MINT_SIZE,
    programAddress: SPL_TOKEN_PROGRAM_ADDRESS,
  });

  // SPL Token InitializeMint2 (discriminator 20):
  //   decimals(1) + mintAuthority(32) + freezeAuthorityOption(1 = None)
  const addrEncoder = getAddressEncoder();
  const initMintData = new Uint8Array(35);
  initMintData[0] = 20; // InitializeMint2 discriminator
  initMintData[1] = decimals;
  initMintData.set(addrEncoder.encode(signer.signer.address), 2);
  initMintData[34] = 0; // freeze authority: None
  const initMintIx = buildInstruction(
    SPL_TOKEN_PROGRAM_ADDRESS,
    [writableAccount(mintSigner.address)],
    initMintData,
  );

  await signer.send({
    instructions: [createAccountIx, initMintIx],
    additionalSigners: [mintSigner],
    skipPreflight: true,
  });

  return mintSigner.address;
}
