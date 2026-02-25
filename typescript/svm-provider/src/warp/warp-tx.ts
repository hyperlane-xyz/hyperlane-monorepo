import {
  type Address,
  address as parseAddress,
  type TransactionSigner,
} from '@solana/kit';

import {
  computeRemoteRoutersUpdates,
  type RawWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { eqAddressSol, eqOptionalAddress } from '@hyperlane-xyz/utils';

import { InterchainGasPaymasterTypeKind } from '../codecs/shared.js';
import {
  getTokenEnrollRemoteRoutersInstruction,
  getTokenSetDestinationGasConfigsInstruction,
  getTokenSetInterchainGasPaymasterInstruction,
  getTokenSetInterchainSecurityModuleInstruction,
  getTokenTransferOwnershipInstruction,
  type TokenInitInstructionData,
} from '../instructions/token.js';
import type { SvmSigner } from '../signer.js';
import type { SvmInstruction, SvmReceipt } from '../types.js';

import { routerHexToBytes } from './warp-query.js';

/**
 * Derives `remoteDecimals` from `localDecimals` and the optional `scale` factor.
 * scale = 10^(remoteDecimals - localDecimals), so
 * remoteDecimals = localDecimals + log10(scale).
 * Falls back to localDecimals when scale is absent or 1.
 */
export function scaleToRemoteDecimals(
  localDecimals: number,
  scale?: number,
): number {
  if (!scale || scale === 1) return localDecimals;
  return localDecimals + Math.round(Math.log10(scale));
}

/**
 * Derives the `scale` factor from on-chain `localDecimals` and `remoteDecimals`.
 * Returns undefined when there is no scaling (remoteDecimals === localDecimals).
 */
export function remoteDecimalsToScale(
  localDecimals: number,
  remoteDecimals: number,
): number | undefined {
  const diff = remoteDecimals - localDecimals;
  return diff === 0 ? undefined : Math.pow(10, diff);
}

/**
 * Builds the TokenInitInstructionData shared by all warp token types.
 * The caller is responsible for passing the token-type-specific decimals.
 */
export function buildBaseInitData(
  config: Pick<
    RawWarpArtifactConfig,
    'mailbox' | 'interchainSecurityModule' | 'hook'
  >,
  igpProgramId: Address,
  decimals: number,
  remoteDecimals: number,
): TokenInitInstructionData {
  const igpAccountAddress = config.hook?.deployed?.address;
  return {
    mailbox: parseAddress(config.mailbox),
    interchainSecurityModule: config.interchainSecurityModule?.deployed?.address
      ? parseAddress(config.interchainSecurityModule.deployed.address)
      : null,
    interchainGasPaymaster: igpAccountAddress
      ? {
          programId: igpProgramId,
          igp: {
            kind: InterchainGasPaymasterTypeKind.OverheadIgp,
            account: parseAddress(igpAccountAddress),
          },
        }
      : null,
    decimals,
    remoteDecimals,
  };
}

/**
 * Sends post-init configuration (remote routers + destination gas) in a
 * single batched transaction. Returns undefined if there is nothing to send.
 */
export async function applyPostInitConfig(
  signer: SvmSigner,
  programId: Address,
  config: Pick<RawWarpArtifactConfig, 'remoteRouters' | 'destinationGas'>,
): Promise<SvmReceipt | undefined> {
  const instructions: SvmInstruction[] = [];

  const routerEntries = Object.entries(config.remoteRouters);
  if (routerEntries.length > 0) {
    instructions.push(
      await getTokenEnrollRemoteRoutersInstruction(
        programId,
        signer.signer,
        routerEntries.map(([domain, router]) => ({
          domain: parseInt(domain),
          router: routerHexToBytes(router.address),
        })),
      ),
    );

    const gasEntries = Object.entries(config.destinationGas);
    if (gasEntries.length > 0) {
      instructions.push(
        await getTokenSetDestinationGasConfigsInstruction(
          programId,
          signer.signer,
          gasEntries.map(([domain, gas]) => ({
            domain: parseInt(domain),
            gas: BigInt(gas),
          })),
        ),
      );
    }
  }

  if (instructions.length === 0) return undefined;
  return signer.send({ instructions });
}

/**
 * Diffs current vs expected config and returns the minimal set of update
 * instructions needed to reconcile them.
 */
export async function computeWarpTokenUpdateInstructions(
  current: RawWarpArtifactConfig,
  expected: RawWarpArtifactConfig,
  programId: Address,
  signerAccount: TransactionSigner,
  igpProgramId?: Address,
): Promise<SvmInstruction[]> {
  const instructions: SvmInstruction[] = [];

  // 1. ISM change
  const currentIsm = current.interchainSecurityModule?.deployed?.address;
  const expectedIsm = expected.interchainSecurityModule?.deployed?.address;
  if (!eqOptionalAddress(currentIsm, expectedIsm, eqAddressSol)) {
    instructions.push(
      await getTokenSetInterchainSecurityModuleInstruction(
        programId,
        signerAccount,
        expectedIsm ? parseAddress(expectedIsm) : null,
      ),
    );
  }

  // 2. IGP hook change
  const currentHook = current.hook?.deployed?.address;
  const expectedHook = expected.hook?.deployed?.address;
  if (!eqOptionalAddress(currentHook, expectedHook, eqAddressSol)) {
    const igpValue: Parameters<
      typeof getTokenSetInterchainGasPaymasterInstruction
    >[2] =
      expectedHook && igpProgramId
        ? [
            igpProgramId,
            {
              kind: InterchainGasPaymasterTypeKind.OverheadIgp,
              account: parseAddress(expectedHook),
            },
          ]
        : null;
    instructions.push(
      await getTokenSetInterchainGasPaymasterInstruction(
        programId,
        signerAccount,
        igpValue,
      ),
    );
  }

  // 3. Router diff
  const diff = computeRemoteRoutersUpdates(
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

  if (diff.toUnenroll.length > 0) {
    instructions.push(
      await getTokenEnrollRemoteRoutersInstruction(
        programId,
        signerAccount,
        diff.toUnenroll.map((domain) => ({ domain, router: null })),
      ),
    );
  }

  if (diff.toEnroll.length > 0) {
    instructions.push(
      await getTokenEnrollRemoteRoutersInstruction(
        programId,
        signerAccount,
        diff.toEnroll.map((e) => ({
          domain: e.domainId,
          router: routerHexToBytes(e.routerAddress),
        })),
      ),
    );
    instructions.push(
      await getTokenSetDestinationGasConfigsInstruction(
        programId,
        signerAccount,
        diff.toEnroll.map((e) => ({
          domain: e.domainId,
          gas: BigInt(e.gas),
        })),
      ),
    );
  }

  // 4. Ownership change (always last)
  if (!eqOptionalAddress(current.owner, expected.owner, eqAddressSol)) {
    instructions.push(
      await getTokenTransferOwnershipInstruction(
        programId,
        signerAccount,
        expected.owner ? parseAddress(expected.owner) : null,
      ),
    );
  }

  return instructions;
}
