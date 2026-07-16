/**
 * Program upgrade logic for Hyperlane SVM programs.
 *
 * Separates upgrade concerns from config diffing. Writers call this
 * before their config-update step when expected.contractVersion differs
 * from the on-chain version.
 */
import type { Address } from '@solana/kit';

import { assert, eqAddressSol } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import {
  EXTEND_PROGRAM_CHECKED_FEATURE,
  MAX_ACCOUNT_DATA_SIZE,
  MAX_COMPUTE_UNITS,
  MIN_PROGRAM_DATA_EXTEND_BYTES,
} from '../constants.js';
import { isFeatureActive } from '../feature-gate.js';
import {
  PROGRAM_DATA_HEADER_SIZE,
  createUpgradeProgramPlan,
  DeployStageKind,
  executeDeployPlan,
  getProgramUpgradeAuthority,
} from './program-deployer.js';
import { deriveProgramDataAddress } from '../pda.js';
import {
  getExtendProgramCheckedInstruction,
  getExtendProgramInstruction,
  getSetBufferAuthorityInstruction,
} from '../instructions/loader.js';
import { compareVersions } from '../version/version-query.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

/**
 * Bytes needed to grow the program-data account for a new binary, clamped up
 * to the loader's minimum single-extend size. Returns 0 when the new binary
 * already fits.
 */
export function requiredExtendBytes(
  newProgramLen: number,
  currentMaxProgramLen: number,
): number {
  if (newProgramLen <= currentMaxProgramLen) {
    return 0;
  }

  return Math.max(
    newProgramLen - currentMaxProgramLen,
    MIN_PROGRAM_DATA_EXTEND_BYTES,
  );
}

/**
 * Whether growing a program-data account of `currentAccountSize` bytes by
 * `additionalBytes` stays within Solana's account-data limit. The extend
 * clamp to the loader minimum can request growth past the cap for a near-full
 * account, which the loader would reject with an opaque error.
 */
export function extendFitsAccountLimit(
  currentAccountSize: number,
  additionalBytes: number,
): boolean {
  return currentAccountSize + additionalBytes <= MAX_ACCOUNT_DATA_SIZE;
}

/**
 * Handles program upgrade for a warp route token program.
 *
 * Creates the buffer and writes program bytes using the provided signer,
 * then returns transactions that require the upgrade authority to execute.
 *
 * The extend and upgrade are returned as separate transactions and must land
 * in separate slots: the loader rejects an Upgrade in the same slot the
 * program-data was extended ("Program was deployed in this block already").
 * For the same reason, any config-change instruction (which invokes the
 * program) must run after the upgrade lands — a program is not invocable in
 * the slot it is upgraded. Both transactions carry `waitForSlotAdvance` so a
 * live signer holds each until the cluster advances a slot, guaranteeing the
 * upgrade lands after the extend and any following config update lands after
 * the upgrade.
 *
 * @returns Upgrade transactions plus receipts from buffer prep.
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
): Promise<{
  authorityTransactions: AnnotatedSvmTransaction[];
  receipts: SvmReceipt[];
} | null> {
  if (!expectedVersion) {
    return null;
  }

  const cmp = currentVersion
    ? compareVersions(expectedVersion, currentVersion)
    : 1;

  if (cmp === 0) {
    return null;
  }

  if (cmp < 0) {
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
  const additionalBytes = requiredExtendBytes(
    programBytes.length,
    currentMaxProgramLen,
  );

  if (additionalBytes > 0) {
    // The clamp to MIN_PROGRAM_DATA_EXTEND_BYTES can push a near-full account
    // past the loader cap; fail fast with a clear message instead of the
    // opaque on-chain loader error.
    assert(
      extendFitsAccountLimit(currentAccountSize, additionalBytes),
      `Cannot upgrade ${label}: new binary needs the program-data account grown to ${currentAccountSize + additionalBytes} bytes, exceeding Solana's ${MAX_ACCOUNT_DATA_SIZE}-byte account limit`,
    );

    const checkedActive = await isFeatureActive(
      rpc,
      EXTEND_PROGRAM_CHECKED_FEATURE,
    );
    const extendInstruction = checkedActive
      ? getExtendProgramCheckedInstruction(
          programDataAddress,
          programId,
          upgradeAuthority,
          upgradeAuthority,
          additionalBytes,
        )
      : getExtendProgramInstruction(
          programDataAddress,
          programId,
          upgradeAuthority,
          additionalBytes,
        );

    authorityTransactions.push({
      feePayer: upgradeAuthority,
      instructions: [extendInstruction],
      computeUnits: MAX_COMPUTE_UNITS,
      annotation: `Extend ${label}: +${additionalBytes} bytes`,
      waitForSlotAdvance: true,
    });
  }

  // Create buffer and write new program bytes.
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

  // Transfer buffer authority to the upgrade authority if they differ.
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

  // Upgrade instruction — requires upgrade authority to sign.
  authorityTransactions.push({
    feePayer: upgradeAuthority,
    instructions: finalizeStage.instructions,
    additionalSigners: finalizeStage.additionalSigners,
    computeUnits: MAX_COMPUTE_UNITS,
    annotation: `Upgrade ${label}: ${currentVersion ?? 'unknown'} → ${expectedVersion}`,
    waitForSlotAdvance: true,
  });

  return { authorityTransactions, receipts };
}
