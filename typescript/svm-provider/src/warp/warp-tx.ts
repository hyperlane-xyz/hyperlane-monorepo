import type { Address } from '@solana/kit';

import type { RawWarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';
import { computeRemoteRoutersUpdates } from '@hyperlane-xyz/provider-sdk/warp';
import { eqAddressSol } from '@hyperlane-xyz/utils';

import {
  getEnrollRemoteRoutersInstructionDataEncoder,
  getSetDestinationGasConfigsInstructionDataEncoder,
  getSetInterchainGasPaymasterInstructionDataEncoder,
  getSetInterchainSecurityModuleInstructionDataEncoder,
  getTransferOwnershipInstructionDataEncoder,
} from '../generated/instructions/index.js';
import type { InterchainGasPaymasterTypeProxyArgs } from '../generated/types/index.js';
import type { SvmInstruction } from '../types.js';

import { getHyperlaneTokenPda, routerHexToBytes } from './warp-query.js';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as Address;

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
export async function getEnrollRemoteRoutersIx(
  programId: Address,
  payer: Address,
  enrollments: RouterEnrollment[],
): Promise<SvmInstruction> {
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

  // Derive token PDA
  const [tokenPda] = await getHyperlaneTokenPda(programId);

  return {
    programAddress: programId,
    accounts: [
      { address: SYSTEM_PROGRAM_ID, role: 0 }, // executable
      { address: tokenPda, role: 1 }, // writable
      { address: payer, role: 2 }, // signer (readonly signer)
    ],
    data,
  };
}

/**
 * Builds unenroll instruction (enrolls with null router).
 */
export async function getUnenrollRemoteRoutersIx(
  programId: Address,
  payer: Address,
  domains: number[],
): Promise<SvmInstruction> {
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

  // Derive token PDA
  const [tokenPda] = await getHyperlaneTokenPda(programId);

  return {
    programAddress: programId,
    accounts: [
      { address: SYSTEM_PROGRAM_ID, role: 0 },
      { address: tokenPda, role: 1 },
      { address: payer, role: 2 },
    ],
    data,
  };
}

/**
 * Builds SetDestinationGasConfigs instruction.
 */
export async function getSetDestinationGasConfigsIx(
  programId: Address,
  payer: Address,
  configs: DestinationGasConfig[],
): Promise<SvmInstruction> {
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

  // Derive token PDA
  const [tokenPda] = await getHyperlaneTokenPda(programId);

  return {
    programAddress: programId,
    accounts: [
      { address: SYSTEM_PROGRAM_ID, role: 0 },
      { address: tokenPda, role: 1 },
      { address: payer, role: 2 },
    ],
    data,
  };
}

/**
 * Builds SetInterchainSecurityModule instruction.
 */
export async function getSetIsmIx(
  programId: Address,
  payer: Address,
  ism: Address | null,
): Promise<SvmInstruction> {
  const encoder = getSetInterchainSecurityModuleInstructionDataEncoder();
  const enumData = encoder.encode({ args: ism });

  // Prepend 8-byte discriminator
  const data = new Uint8Array(8 + enumData.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(enumData, 8);

  // Derive token PDA
  const [tokenPda] = await getHyperlaneTokenPda(programId);

  return {
    programAddress: programId,
    accounts: [
      { address: tokenPda, role: 1 },
      { address: payer, role: 2 },
    ],
    data,
  };
}

/**
 * Builds SetInterchainGasPaymaster instruction.
 * Pass null to clear the IGP.
 * accountType defaults to 'OverheadIgp' (typical for warp routes).
 */
export async function getSetIgpIx(
  programId: Address,
  payer: Address,
  igp: {
    igpProgramId: Address;
    accountAddress: Address;
    accountType?: 'Igp' | 'OverheadIgp';
  } | null,
): Promise<SvmInstruction> {
  const encoder = getSetInterchainGasPaymasterInstructionDataEncoder();
  const igpArg: readonly [Address, InterchainGasPaymasterTypeProxyArgs] | null =
    igp
      ? [
          igp.igpProgramId,
          {
            __kind: igp.accountType ?? 'OverheadIgp',
            fields: [igp.accountAddress],
          } as InterchainGasPaymasterTypeProxyArgs,
        ]
      : null;

  const enumData = encoder.encode({ args: igpArg });
  const data = new Uint8Array(8 + enumData.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(enumData, 8);

  const [tokenPda] = await getHyperlaneTokenPda(programId);

  return {
    programAddress: programId,
    accounts: [
      { address: tokenPda, role: 1 },
      { address: payer, role: 2 },
    ],
    data,
  };
}

/**
 * Builds TransferOwnership instruction.
 */
export async function getTransferOwnershipIx(
  programId: Address,
  payer: Address,
  newOwner: Address | null,
): Promise<SvmInstruction> {
  const encoder = getTransferOwnershipInstructionDataEncoder();
  const enumData = encoder.encode({ args: newOwner });

  // Prepend 8-byte discriminator
  const data = new Uint8Array(8 + enumData.length);
  data.set(PROGRAM_INSTRUCTION_DISCRIMINATOR, 0);
  data.set(enumData, 8);

  // Derive token PDA
  const [tokenPda] = await getHyperlaneTokenPda(programId);

  return {
    programAddress: programId,
    accounts: [
      { address: tokenPda, role: 1 }, // writable
      { address: payer, role: 2 }, // signer
    ],
    data,
  };
}

/**
 * Computes update instructions by diffing current and expected configs.
 * Pass igpProgramId when the warp token uses an IGP hook so that IGP
 * changes can be applied. The account address comes from hook.deployed.address.
 */
export async function computeWarpTokenUpdateInstructions(
  current: RawWarpArtifactConfig,
  expected: RawWarpArtifactConfig,
  programId: Address,
  payer: Address,
  igpProgramId?: Address,
): Promise<SvmInstruction[]> {
  const instructions: SvmInstruction[] = [];

  // 1. Update ISM if changed
  const currentIsm = current.interchainSecurityModule?.deployed?.address;
  const expectedIsm = expected.interchainSecurityModule?.deployed?.address;

  if (currentIsm !== expectedIsm) {
    instructions.push(
      await getSetIsmIx(programId, payer, (expectedIsm as Address) ?? null),
    );
  }

  // 2. Update IGP hook if changed
  const currentHookAddress = current.hook?.deployed?.address;
  const expectedHookAddress = expected.hook?.deployed?.address;

  if (currentHookAddress !== expectedHookAddress) {
    const igp =
      expectedHookAddress && igpProgramId
        ? {
            igpProgramId,
            accountAddress: expectedHookAddress as Address,
          }
        : null;
    instructions.push(await getSetIgpIx(programId, payer, igp));
  }

  // 3. Compute router diff
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

  // 4. Unenroll removed routers
  if (routerDiff.toUnenroll.length > 0) {
    instructions.push(
      await getUnenrollRemoteRoutersIx(programId, payer, routerDiff.toUnenroll),
    );
  }

  // 5. Enroll new/updated routers with destination gas
  if (routerDiff.toEnroll.length > 0) {
    instructions.push(
      await getEnrollRemoteRoutersIx(
        programId,
        payer,
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

    instructions.push(
      await getSetDestinationGasConfigsIx(programId, payer, gasConfigs),
    );
  }

  // 6. Transfer ownership (always last)
  if (current.owner !== expected.owner) {
    instructions.push(
      await getTransferOwnershipIx(programId, payer, expected.owner as Address),
    );
  }

  return instructions;
}
