import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  generateKeyPairSigner,
  getAddressEncoder,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs';
// eslint-disable-next-line import/no-nodejs-modules
import * as path from 'path';

import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
} from '../instructions/utils.js';
import type { SvmSigner } from '../signer.js';
import {
  RENT_SYSVAR_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
} from '../constants.js';
import type { SvmRpc } from '../types.js';

import type { PreloadedProgram } from './solana-container.js';

function findMonorepoRoot(): string {
  let dir = process.cwd();
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export const DEFAULT_PROGRAMS_PATH = path.join(
  findMonorepoRoot(),
  'rust/sealevel/target/deploy',
);

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

export function getPreloadedPrograms(
  programs: Array<keyof typeof PROGRAM_BINARIES>,
  programsPath: string = DEFAULT_PROGRAMS_PATH,
): PreloadedProgram[] {
  return programs.map((program) => ({
    programId: TEST_PROGRAM_IDS[program as keyof typeof TEST_PROGRAM_IDS],
    soPath: path.join(programsPath, PROGRAM_BINARIES[program]),
  }));
}

export async function airdropSol(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
  lamports: bigint = 10_000_000_000n,
): Promise<void> {
  const signature = await rpc.requestAirdrop(address, lamports as any).send();

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
    [writableAccount(mintSigner.address), readonlyAccount(RENT_SYSVAR_ADDRESS)],
    initMintData,
  );

  await signer.send({
    instructions: [createAccountIx, initMintIx],
    additionalSigners: [mintSigner],
    skipPreflight: true,
  });

  return mintSigner.address;
}
