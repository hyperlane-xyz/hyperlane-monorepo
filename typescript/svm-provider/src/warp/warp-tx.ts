import {
  AccountRole,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  address,
} from '@solana/kit';

import type { RawWarpArtifactConfig } from '@hyperlane-xyz/provider-sdk/warp';
import { computeRemoteRoutersUpdates } from '@hyperlane-xyz/provider-sdk/warp';
import { eqAddressSol, eqOptionalAddress } from '@hyperlane-xyz/utils';

import {
  getEnrollRemoteRoutersInstructionDataEncoder,
  getSetDestinationGasConfigsInstructionDataEncoder,
  getSetInterchainGasPaymasterInstructionDataEncoder,
  getSetInterchainSecurityModuleInstructionDataEncoder,
  getTransferOwnershipInstructionDataEncoder,
} from '../generated/instructions/index.js';
import type {
  InitProxyArgs,
  InterchainGasPaymasterTypeProxyArgs,
} from '../generated/types/index.js';
import type { SvmSigner } from '../signer.js';
import type { SvmInstruction, SvmReceipt } from '../types.js';

import { SYSTEM_PROGRAM_ID, prependDiscriminator } from './constants.js';
import { getHyperlaneTokenPda, routerHexToBytes } from './warp-query.js';

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
  routesToEnroll: RouterEnrollment[],
): Promise<SvmInstruction> {
  const encoder = getEnrollRemoteRoutersInstructionDataEncoder();
  const data = prependDiscriminator(
    encoder.encode({
      args: routesToEnroll.map((route) => ({
        domain: route.domain,
        router: route.router ? routerHexToBytes(route.router) : null,
      })),
    }),
  );

  const [tokenPda] = await getHyperlaneTokenPda(programId);
  return {
    programAddress: programId,
    accounts: [
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      { address: tokenPda, role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.READONLY_SIGNER },
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
  const data = prependDiscriminator(
    encoder.encode({
      args: domains.map((domain) => ({ domain, router: null })),
    }),
  );

  const [tokenPda] = await getHyperlaneTokenPda(programId);
  return {
    programAddress: programId,
    accounts: [
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      { address: tokenPda, role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.READONLY_SIGNER },
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
  const data = prependDiscriminator(
    encoder.encode({
      args: configs.map((c) => ({ domain: c.domain, gas: c.gas })),
    }),
  );

  const [tokenPda] = await getHyperlaneTokenPda(programId);
  return {
    programAddress: programId,
    accounts: [
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      { address: tokenPda, role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.READONLY_SIGNER },
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
  const data = prependDiscriminator(encoder.encode({ args: ism }));

  const [tokenPda] = await getHyperlaneTokenPda(programId);
  return {
    programAddress: programId,
    accounts: [
      { address: tokenPda, role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.READONLY_SIGNER },
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
          },
        ]
      : null;

  const data = prependDiscriminator(encoder.encode({ args: igpArg }));
  const [tokenPda] = await getHyperlaneTokenPda(programId);

  return {
    programAddress: programId,
    accounts: [
      { address: tokenPda, role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.READONLY_SIGNER },
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
  const data = prependDiscriminator(encoder.encode({ args: newOwner }));

  const [tokenPda] = await getHyperlaneTokenPda(programId);
  return {
    programAddress: programId,
    accounts: [
      { address: tokenPda, role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.READONLY_SIGNER },
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

  if (!eqOptionalAddress(currentIsm, expectedIsm, eqAddressSol)) {
    instructions.push(
      await getSetIsmIx(
        programId,
        payer,
        expectedIsm ? address(expectedIsm) : null,
      ),
    );
  }

  // 2. Update IGP hook if changed
  const currentHookAddress = current.hook?.deployed?.address;
  const expectedHookAddress = expected.hook?.deployed?.address;

  if (
    !eqOptionalAddress(currentHookAddress, expectedHookAddress, eqAddressSol)
  ) {
    const igp =
      expectedHookAddress && igpProgramId
        ? {
            igpProgramId,
            accountAddress: address(expectedHookAddress),
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
  if (!eqOptionalAddress(current.owner, expected.owner, eqAddressSol)) {
    instructions.push(
      await getTransferOwnershipIx(
        programId,
        payer,
        expected.owner ? address(expected.owner) : null,
      ),
    );
  }

  return instructions;
}

/**
 * Builds the common InitProxyArgs shared by all warp token types.
 * Handles mailbox, ISM, and IGP; decimals are token-type-specific.
 */
export function buildBaseInitArgs(
  config: Pick<
    RawWarpArtifactConfig,
    'mailbox' | 'interchainSecurityModule' | 'hook'
  >,
  igpProgramId: Address,
  decimals: number,
  remoteDecimals: number,
): InitProxyArgs {
  const igpAccountAddress = config.hook?.deployed?.address;
  return {
    mailbox: address(config.mailbox),
    interchainSecurityModule: config.interchainSecurityModule?.deployed?.address
      ? address(config.interchainSecurityModule.deployed.address)
      : null,
    interchainGasPaymaster: igpAccountAddress
      ? [
          igpProgramId,
          { __kind: 'OverheadIgp', fields: [address(igpAccountAddress)] },
        ]
      : null,
    decimals,
    remoteDecimals,
  };
}

/**
 * Sends all post-init configuration instructions (routers, gas, ISM) in a
 * single batched transaction. Returns the receipt, or undefined if there is
 * nothing to configure.
 */
export async function applyPostInitConfig(
  rpc: Rpc<SolanaRpcApi>,
  signer: SvmSigner,
  programId: Address,
  config: Pick<
    RawWarpArtifactConfig,
    'remoteRouters' | 'destinationGas' | 'interchainSecurityModule'
  >,
): Promise<SvmReceipt | undefined> {
  const instructions: SvmInstruction[] = [];

  if (Object.keys(config.remoteRouters).length > 0) {
    const enrollments: RouterEnrollment[] = Object.entries(
      config.remoteRouters,
    ).map(([domain, router]) => ({
      domain: parseInt(domain),
      router: router.address,
    }));
    instructions.push(
      await getEnrollRemoteRoutersIx(programId, signer.address, enrollments),
    );
  }

  if (Object.keys(config.destinationGas).length > 0) {
    const gasConfigs: DestinationGasConfig[] = Object.entries(
      config.destinationGas,
    ).map(([domain, gas]) => ({
      domain: parseInt(domain),
      gas: BigInt(gas),
    }));
    instructions.push(
      await getSetDestinationGasConfigsIx(
        programId,
        signer.address,
        gasConfigs,
      ),
    );
  }

  // if (config.interchainSecurityModule?.deployed?.address) {
  //   instructions.push(
  //     await getSetIsmIx(
  //       programId,
  //       signer.address,
  //       address(config.interchainSecurityModule.deployed.address),
  //     ),
  //   );
  // }

  if (instructions.length === 0) {
    return undefined;
  }

  return signer.signAndSend(rpc, { instructions });
}
