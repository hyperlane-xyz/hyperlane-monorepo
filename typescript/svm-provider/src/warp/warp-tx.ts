import type { Address } from '@solana/kit';

import type { RawWarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';
import { computeRemoteRoutersUpdates } from '@hyperlane-xyz/provider-sdk/warp';
import { eqAddressSol } from '@hyperlane-xyz/utils';

import {
  getEnrollRemoteRoutersInstructionDataEncoder,
  getSetDestinationGasConfigsInstructionDataEncoder,
  getSetInterchainSecurityModuleInstructionDataEncoder,
  getTransferOwnershipInstructionDataEncoder,
} from '../generated/instructions/index.js';
import type { SvmInstruction } from '../types.js';

import { routerHexToBytes } from './warp-query.js';

/**
 * Program instruction discriminator used by all Hyperlane token instructions.
 * From Rust: PROGRAM_INSTRUCTION_DISCRIMINATOR = [1,1,1,1,1,1,1,1]
 */
const PROGRAM_INSTRUCTION_DISCRIMINATOR = new Uint8Array([
  1, 1, 1, 1, 1, 1, 1, 1,
]);

/**
 * Remote router enrollment configuration.
 */
export interface RouterEnrollment {
  domain: number;
  router: string;
}

/**
 * Destination gas configuration.
 */
export interface DestinationGasConfig {
  domain: number;
  gas: bigint | null;
}

/**
 * Builds EnrollRemoteRouters instruction.
 * Note: Generated instruction has no accounts, so we build manually.
 */
export function getEnrollRemoteRoutersIx(
  programId: Address,
  enrollments: RouterEnrollment[],
): SvmInstruction {
  const encoder = getEnrollRemoteRoutersInstructionDataEncoder();
  const enumData = encoder.encode({
    args: enrollments.map((e) => ({
      domain: e.domain,
      router: e.router ? routerHexToBytes(e.router) : null,
    })),
  });

  // Prepend 8-byte discriminator
  const data = new Uint8Array(8 + enumData.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(enumData, 8);

  return {
    programAddress: programId,
    accounts: [],
    data,
  };
}

/**
 * Builds unenroll instruction (enrolls with null router).
 */
export function getUnenrollRemoteRoutersIx(
  programId: Address,
  domains: number[],
): SvmInstruction {
  const encoder = getEnrollRemoteRoutersInstructionDataEncoder();
  const enumData = encoder.encode({
    args: domains.map((domain) => ({
      domain,
      router: null,
    })),
  });

  // Prepend 8-byte discriminator
  const data = new Uint8Array(8 + enumData.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(enumData, 8);

  return {
    programAddress: programId,
    accounts: [],
    data,
  };
}

/**
 * Builds SetDestinationGasConfigs instruction.
 */
export function getSetDestinationGasConfigsIx(
  programId: Address,
  configs: DestinationGasConfig[],
): SvmInstruction {
  const encoder = getSetDestinationGasConfigsInstructionDataEncoder();
  const enumData = encoder.encode({
    args: configs.map((c) => ({
      domain: c.domain,
      gas: c.gas,
    })),
  });

  // Prepend 8-byte discriminator
  const data = new Uint8Array(8 + enumData.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(enumData, 8);

  return {
    programAddress: programId,
    accounts: [],
    data,
  };
}

/**
 * Builds SetInterchainSecurityModule instruction.
 */
export function getSetIsmIx(
  programId: Address,
  ism: Address | null,
): SvmInstruction {
  const encoder = getSetInterchainSecurityModuleInstructionDataEncoder();
  const enumData = encoder.encode({ args: ism });

  // Prepend 8-byte discriminator
  const data = new Uint8Array(8 + enumData.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(enumData, 8);

  return {
    programAddress: programId,
    accounts: [],
    data,
  };
}

/**
 * Builds TransferOwnership instruction.
 */
export function getTransferOwnershipIx(
  programId: Address,
  newOwner: Address | null,
): SvmInstruction {
  const encoder = getTransferOwnershipInstructionDataEncoder();
  const enumData = encoder.encode({ args: newOwner });

  // Prepend 8-byte discriminator
  const data = new Uint8Array(8 + enumData.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(enumData, 8);

  return {
    programAddress: programId,
    accounts: [],
    data,
  };
}

/**
 * Computes update instructions by diffing current and expected configs.
 */
export function computeWarpTokenUpdateInstructions(
  current: RawWarpArtifactConfig,
  expected: RawWarpArtifactConfig,
  programId: Address,
): SvmInstruction[] {
  const instructions: SvmInstruction[] = [];

  // 1. Update ISM if changed
  const currentIsm = current.interchainSecurityModule?.deployed?.address;
  const expectedIsm = expected.interchainSecurityModule?.deployed?.address;

  if (currentIsm !== expectedIsm) {
    instructions.push(getSetIsmIx(programId, (expectedIsm as Address) ?? null));
  }

  // 2. Compute router diff
  const routerDiff = computeRemoteRoutersUpdates(
    {
      remoteRouters: current.remoteRouters,
      destinationGas: current.destinationGas,
    },
    {
      remoteRouters: expected.remoteRouters,
      destinationGas: expected.destinationGas,
    },
    eqAddressSol,
  );

  // 3. Unenroll removed routers
  if (routerDiff.toUnenroll.length > 0) {
    instructions.push(
      getUnenrollRemoteRoutersIx(programId, routerDiff.toUnenroll),
    );
  }

  // 4. Enroll new/updated routers with destination gas
  if (routerDiff.toEnroll.length > 0) {
    instructions.push(
      getEnrollRemoteRoutersIx(
        programId,
        routerDiff.toEnroll.map((e) => ({
          domain: e.domainId,
          router: e.routerAddress,
        })),
      ),
    );

    // Set destination gas for enrolled routers
    const gasConfigs: DestinationGasConfig[] = routerDiff.toEnroll.map((e) => ({
      domain: e.domainId,
      gas: BigInt(e.gas),
    }));

    instructions.push(getSetDestinationGasConfigsIx(programId, gasConfigs));
  }

  // 5. Transfer ownership (always last)
  if (current.owner !== expected.owner) {
    instructions.push(
      getTransferOwnershipIx(programId, expected.owner as Address),
    );
  }

  return instructions;
}
