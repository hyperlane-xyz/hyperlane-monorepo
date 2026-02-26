import { type Address, address as parseAddress } from '@solana/kit';

import {
  computeRemoteRoutersUpdates,
  type RawWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  assert,
  eqAddressSol,
  eqOptionalAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { InterchainGasPaymasterTypeKind } from '../codecs/shared.js';
import { u32le } from '../codecs/binary.js';
import {
  getTokenEnrollRemoteRoutersInstruction,
  getTokenSetDestinationGasConfigsInstruction,
  getTokenSetInterchainGasPaymasterInstruction,
  getTokenSetInterchainSecurityModuleInstruction,
  getTokenTransferOwnershipInstruction,
  type TokenInitInstructionData,
} from '../instructions/token.js';
import {
  buildInstruction,
  writableAccount,
  writableSignerAddress,
} from '../instructions/utils.js';
import { deriveAtaPayerPda } from '../pda.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import type { SvmSigner } from '../signer.js';
import type { SvmInstruction, SvmRpc, SvmReceipt } from '../types.js';

import { routerHexToBytes } from './warp-query.js';

/** Maximum local decimals allowed by the on-chain SVM token programs. */
const MAX_LOCAL_DECIMALS = 9;

/**
 * Asserts that `localDecimals` does not exceed the SVM maximum of 9.
 * The on-chain program stores decimals as u8 and the decimal-conversion math
 * overflows for values > 9. Mirrors the Rust client's `assert_decimals_max`.
 */
export function assertLocalDecimals(localDecimals: number): void {
  assert(
    localDecimals <= MAX_LOCAL_DECIMALS,
    `Invalid decimals: ${localDecimals}. Must be <= ${MAX_LOCAL_DECIMALS}. Use scale/remoteDecimals for higher-precision remote chains.`,
  );
}

/**
 * Derives `remoteDecimals` from `localDecimals` and the optional `scale` factor.
 * scale = 10^(remoteDecimals - localDecimals), so
 * remoteDecimals = localDecimals + log10(scale).
 * Falls back to localDecimals when scale is absent or 1.
 * Asserts that scale is an exact power of 10.
 */
export function scaleToRemoteDecimals(
  localDecimals: number,
  scale?: number,
): number {
  if (!scale || scale === 1) return localDecimals;
  const exp = Math.round(Math.log10(scale));
  assert(
    Math.pow(10, exp) === scale,
    `scale must be an exact power of 10 (e.g. 1e9), got ${scale}`,
  );
  return localDecimals + exp;
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
        signer.signer.address,
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
          signer.signer.address,
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
 * Returns a System Program transfer instruction to top up the ATA payer PDA
 * to at least `targetLamports`, or undefined if already sufficiently funded.
 * For synthetic and collateral tokens the ATA payer funds recipient ATA
 * creation on transfer_out.
 */
export async function buildFundAtaPayerInstruction(
  rpc: SvmRpc,
  payer: Address,
  programId: Address,
  targetLamports: bigint,
): Promise<SvmInstruction | undefined> {
  const { address: ataPayerPda } = await deriveAtaPayerPda(programId);
  const balance = await rpc.getBalance(ataPayerPda).send();
  const current = BigInt(balance.value);
  if (current >= targetLamports) return undefined;

  const topUp = targetLamports - current;
  const data = new Uint8Array(12);
  data.set(u32le(2), 0); // SystemProgram::Transfer discriminator (u32 LE)
  new DataView(data.buffer).setBigUint64(4, topUp, true); // lamports, LE

  return buildInstruction(
    SYSTEM_PROGRAM_ADDRESS,
    [writableSignerAddress(payer), writableAccount(ataPayerPda)],
    data,
  );
}

/**
 * Diffs current vs expected config and returns the minimal set of update
 * instructions needed to reconcile them.
 */
export async function computeWarpTokenUpdateInstructions(
  current: RawWarpArtifactConfig,
  expected: RawWarpArtifactConfig,
  programId: Address,
  ownerAddress: Address,
  igpProgramId: Address,
): Promise<SvmInstruction[]> {
  const instructions: SvmInstruction[] = [];

  // 1. ISM change
  const currentIsm = current.interchainSecurityModule?.deployed?.address;
  const expectedIsm = expected.interchainSecurityModule?.deployed?.address;
  if (!eqOptionalAddress(currentIsm, expectedIsm, eqAddressSol)) {
    instructions.push(
      await getTokenSetInterchainSecurityModuleInstruction(
        programId,
        ownerAddress,
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
    >[2] = expectedHook
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
        ownerAddress,
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
        ownerAddress,
        diff.toUnenroll.map((domain) => ({ domain, router: null })),
      ),
    );
    instructions.push(
      await getTokenSetDestinationGasConfigsInstruction(
        programId,
        ownerAddress,
        diff.toUnenroll.map((domain) => ({ domain, gas: null })),
      ),
    );
  }

  if (diff.toEnroll.length > 0) {
    instructions.push(
      await getTokenEnrollRemoteRoutersInstruction(
        programId,
        ownerAddress,
        diff.toEnroll.map((e) => ({
          domain: e.domainId,
          router: routerHexToBytes(e.routerAddress),
        })),
      ),
    );
    instructions.push(
      await getTokenSetDestinationGasConfigsInstruction(
        programId,
        ownerAddress,
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
        ownerAddress,
        expected.owner && !isZeroishAddress(expected.owner)
          ? parseAddress(expected.owner)
          : null,
      ),
    );
  }

  return instructions;
}
