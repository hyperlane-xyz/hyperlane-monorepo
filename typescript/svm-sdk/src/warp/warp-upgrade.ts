/**
 * Program upgrade logic for warp route token programs.
 *
 * Separates upgrade concerns from config diffing (warp-tx.ts).
 * Writers call this before computeWarpTokenUpdateInstructions
 * when contractVersion in the expected config differs from current.
 */
import type { Address } from '@solana/kit';

import { assert, eqAddressSol } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import {
  createUpgradeProgramPlan,
  DeployStageKind,
  executeDeployPlan,
  getProgramUpgradeAuthority,
} from '../deploy/program-deployer.js';
import {
  getExtendProgramCheckedInstruction,
  getSetBufferAuthorityInstruction,
} from '../instructions/loader.js';
import { getTokenSetFeeConfigInstruction } from '../instructions/token.js';
import { deriveProgramDataAddress } from '../pda.js';
import {
  compareVersions,
  supportsFeeConfig,
} from '../version/version-query.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

/** BPF Loader v3 ProgramData account header size (discriminant + slot + option + authority). */
const PROGRAM_DATA_HEADER_SIZE = 45;

/**
 * Handles program upgrade for a warp route token program.
 *
 * Creates the buffer and writes program bytes using the provided signer,
 * then returns transactions that require the upgrade authority to execute:
 * - ExtendProgramChecked (if the new binary is larger)
 * - Upgrade (swap the program binary)
 *
 * The returned transactions have feePayer set to the on-chain upgrade
 * authority. When authority == signer, they can be executed immediately.
 * When authority differs, the caller routes them to the authority.
 *
 * @returns Transactions for the authority, plus receipts from buffer prep.
 *          Null if no upgrade is needed.
 * @throws If downgrade is attempted, or the program is immutable.
 */
export async function prepareProgramUpgrade(
  programId: Address,
  currentVersion: string | undefined,
  expectedVersion: string | undefined,
  programBytes: Uint8Array,
  signer: SvmSigner,
  rpc: SvmRpc,
  label: string,
  /** Token owner address — signs the SetFeeConfig(None) migration (distinct from upgrade authority). */
  owner: Address,
): Promise<{
  authorityTransactions: AnnotatedSvmTransaction[];
  receipts: SvmReceipt[];
} | null> {
  if (!expectedVersion || currentVersion === expectedVersion) {
    return null;
  }

  if (currentVersion && compareVersions(expectedVersion, currentVersion) < 0) {
    throw new Error(
      `Cannot downgrade ${label}: deployed version ${currentVersion} is newer than expected ${expectedVersion}`,
    );
  }

  const upgradeAuthority = await getProgramUpgradeAuthority(rpc, programId);
  assert(
    upgradeAuthority,
    `Program upgrade required for ${label} but program is immutable (no upgrade authority)`,
  );

  const receipts: SvmReceipt[] = [];
  const authorityTransactions: AnnotatedSvmTransaction[] = [];

  // Check if the program data account needs extending for the new binary.
  const programDataAddress = await deriveProgramDataAddress(programId);
  const programDataAccount = await rpc
    .getAccountInfo(programDataAddress, { encoding: 'base64' })
    .send();
  assert(
    programDataAccount.value,
    `Program data account not found for ${label}`,
  );

  const currentAccountSize = Buffer.from(
    programDataAccount.value.data[0],
    'base64',
  ).length;
  const currentMaxProgramLen = currentAccountSize - PROGRAM_DATA_HEADER_SIZE;
  const additionalBytes = programBytes.length - currentMaxProgramLen;

  if (additionalBytes > 0) {
    const extendIx = getExtendProgramCheckedInstruction(
      programDataAddress,
      programId,
      upgradeAuthority,
      upgradeAuthority,
      additionalBytes,
    );

    authorityTransactions.push({
      feePayer: upgradeAuthority,
      instructions: [extendIx],
      annotation: `Extend ${label}: +${additionalBytes} bytes`,
    });
  }

  // Create buffer and write new program bytes.
  // Buffer is owned by the payer (signer). The final Upgrade instruction
  // targets the real on-chain upgrade authority (which may differ).
  const plan = await createUpgradeProgramPlan({
    payer: signer.signer,
    authority: signer.signer,
    programAddress: programId,
    newProgramBytes: programBytes,
    upgradeAuthority,
    getMinimumBalanceForRentExemption: (size: number) =>
      rpc.getMinimumBalanceForRentExemption(BigInt(size)).send(),
  });

  // Execute buffer creation + writes immediately (payer-only, no authority needed).
  const finalizeStage = plan.stages.pop();
  assert(
    finalizeStage && finalizeStage.kind === DeployStageKind.Finalize,
    'Expected last stage to be the finalize/upgrade stage',
  );

  const result = await executeDeployPlan({
    plan,
    executeStage: async (stage) =>
      signer.send({
        instructions: stage.instructions,
        additionalSigners: stage.additionalSigners,
      }),
  });
  receipts.push(...result);

  // Transfer buffer authority to the upgrade authority. The Loader requires
  // the buffer authority to match the program's upgrade authority on Upgrade.
  // When payer == upgradeAuthority this is a no-op (already matches).
  if (!eqAddressSol(signer.signer.address, upgradeAuthority)) {
    const initStage = plan.stages.find((s) => s.kind === DeployStageKind.Init);
    assert(initStage, 'Expected init stage in upgrade plan');
    const bufferSigner = initStage.additionalSigners?.[0];
    assert(bufferSigner, 'Expected buffer signer in init stage');

    const transferIx = getSetBufferAuthorityInstruction(
      bufferSigner.address,
      signer.signer.address,
      upgradeAuthority,
    );
    receipts.push(await signer.send({ instructions: [transferIx] }));
  }

  // The Upgrade instruction requires the upgrade authority to sign it.
  authorityTransactions.push({
    feePayer: upgradeAuthority,
    instructions: finalizeStage.instructions,
    additionalSigners: finalizeStage.additionalSigners,
    annotation: `Upgrade ${label}: ${currentVersion ?? 'unknown'} → ${expectedVersion}`,
  });

  // Post-upgrade migration: when upgrading from a pre-fee binary, the token
  // account is 1 byte too small (missing the fee_config Option tag). Handlers
  // that use store(account, false) — transfer_ownership, set_ism, set_igp —
  // will fail with BorshIoError. SetFeeConfig(None) uses store_with_rent_exempt_realloc
  // which grows the account and covers the rent delta.
  //
  // This MUST be a separate transaction — Solana's DELAY_VISIBILITY_SLOT_OFFSET
  // means the new binary is only callable in the slot after the Upgrade tx.
  // If this migration fails, the operator must manually send SetFeeConfig(None)
  // to recover the program before any other config changes will succeed.
  if (!supportsFeeConfig(currentVersion ?? null)) {
    authorityTransactions.push({
      feePayer: owner,
      instructions: [
        await getTokenSetFeeConfigInstruction(programId, owner, null),
      ],
      annotation: `Migrate ${label}: realloc token account for fee_config field`,
    });
  }

  return { authorityTransactions, receipts };
}
