import type { Address } from '@solana/kit';

import { pollAsync } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import type { SvmProgramTarget, SvmReceipt, SvmRpc } from '../types.js';

import {
  type DeployStage,
  createDeployProgramPlan,
  executeDeployPlan,
} from './program-deployer.js';

export interface ResolvedProgram {
  programAddress: Address;
  receipts: SvmReceipt[];
}

async function waitForProgramDeployment(
  rpc: SvmRpc,
  programAddress: Address,
): Promise<void> {
  await pollAsync(
    async () => {
      const account = await rpc
        .getAccountInfo(programAddress, { encoding: 'base64' })
        .send();
      if (!account.value) {
        throw new Error(`Program ${programAddress} not yet visible`);
      }
    },
    1000,
    30,
  );
}

export async function resolveProgram(
  target: SvmProgramTarget,
  signer: SvmSigner,
  rpc: SvmRpc,
  useExactDataLen?: boolean,
): Promise<ResolvedProgram> {
  if ('programId' in target) {
    return { programAddress: target.programId, receipts: [] };
  }

  const plan = await createDeployProgramPlan({
    payer: signer.signer,
    programBytes: target.programBytes,
    getMinimumBalanceForRentExemption: (size: number) =>
      rpc.getMinimumBalanceForRentExemption(BigInt(size)).send(),
    // Exact data len minimizes rent cost. Programs can still be upgraded to
    // the same size binary. Use the 2x default (undefined) if future upgrades
    // may grow the binary beyond the current size.
    maxDataLen: useExactDataLen
      ? BigInt(target.programBytes.length)
      : undefined,
  });

  const executeStage = async (stage: DeployStage): Promise<SvmReceipt> =>
    signer.send({
      instructions: stage.instructions,
      additionalSigners: stage.additionalSigners,
    });

  const receipts = await executeDeployPlan({ plan, executeStage });
  // Some SVM chains acknowledge deployment before the new program can be
  // immediately queried or invoked. Wait until the program account is visible
  // before returning so follow-up init/config txs do not race the deploy.
  await waitForProgramDeployment(rpc, plan.programAddress);
  return { programAddress: plan.programAddress, receipts };
}
