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
import { MAX_COMPUTE_UNITS } from '../constants.js';
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
  getSetBufferAuthorityInstruction,
} from '../instructions/loader.js';
import { compareVersions } from '../version/version-query.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

/**
 * Handles program upgrade for a warp route token program.
 *
 * Creates the buffer and writes program bytes using the provided signer,
 * then returns transactions that require the upgrade authority to execute.
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
  const additionalBytes = programBytes.length - currentMaxProgramLen;

  if (additionalBytes > 0) {
    authorityTransactions.push({
      feePayer: upgradeAuthority,
      instructions: [
        getExtendProgramCheckedInstruction(
          programDataAddress,
          programId,
          upgradeAuthority,
          upgradeAuthority,
          additionalBytes,
        ),
      ],
      computeUnits: MAX_COMPUTE_UNITS,
      annotation: `Extend ${label}: +${additionalBytes} bytes`,
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
  });

  return { authorityTransactions, receipts };
}
