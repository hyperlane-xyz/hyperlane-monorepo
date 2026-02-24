import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs';
// eslint-disable-next-line import/no-nodejs-modules
import * as path from 'path';

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
