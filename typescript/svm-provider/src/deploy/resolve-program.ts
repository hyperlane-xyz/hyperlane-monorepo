import type { Address } from '@solana/kit';

import type { SvmSigner } from '../signer.js';
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
  return { programAddress: plan.programAddress, receipts };
}
