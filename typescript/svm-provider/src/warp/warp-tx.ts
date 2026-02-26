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
import type {
  AnnotatedSvmTransaction,
  SvmInstruction,
  SvmRpc,
  SvmReceipt,
} from '../types.js';

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

// Each router entry is 37 bytes in the EnrollRemoteRouters instruction data.
// With ~322 bytes of fixed tx overhead the 1232-byte limit allows at most 24
// routers per tx. Use 20 to stay comfortably within that bound.
const MAX_ROUTERS_PER_TX = 20;

// Each gas config entry is 13 bytes in SetDestinationGasConfigs instruction
// data. The same fixed overhead allows at most 70 configs per tx. Use 60.
const MAX_GAS_CONFIGS_PER_TX = 60;

/**
 * Sends post-init configuration (remote routers + destination gas) in
 * separate, batched transactions — matching the Rust CLI behaviour — to
 * stay within Solana's 1232-byte transaction size limit.
 *
 * Router enrollments and gas configs are issued as independent instruction
 * streams so each can use its full per-tx budget.
 */
export async function applyPostInitConfig(
  signer: SvmSigner,
  programId: Address,
  config: Pick<RawWarpArtifactConfig, 'remoteRouters' | 'destinationGas'>,
): Promise<SvmReceipt[]> {
  const receipts: SvmReceipt[] = [];

  const routerEntries = Object.entries(config.remoteRouters);
  for (let i = 0; i < routerEntries.length; i += MAX_ROUTERS_PER_TX) {
    const batch = routerEntries.slice(i, i + MAX_ROUTERS_PER_TX);
    receipts.push(
      await signer.send({
        instructions: [
          await getTokenEnrollRemoteRoutersInstruction(
            programId,
            signer.signer.address,
            batch.map(([domain, router]) => ({
              domain: parseInt(domain),
              router: routerHexToBytes(router.address),
            })),
          ),
        ],
      }),
    );
  }

  const gasEntries = Object.entries(config.destinationGas);
  for (let i = 0; i < gasEntries.length; i += MAX_GAS_CONFIGS_PER_TX) {
    const batch = gasEntries.slice(i, i + MAX_GAS_CONFIGS_PER_TX);
    receipts.push(
      await signer.send({
        instructions: [
          await getTokenSetDestinationGasConfigsInstruction(
            programId,
            signer.signer.address,
            batch.map(([domain, gas]) => ({
              domain: parseInt(domain),
              gas: BigInt(gas),
            })),
          ),
        ],
      }),
    );
  }

  return receipts;
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
 * Diffs current vs expected config and returns the minimal set of annotated
 * update transactions needed to reconcile them, batched to stay within
 * Solana's 1232-byte transaction size limit.
 *
 * Transaction grouping:
 *   1. ISM + IGP hook changes (combined, both are small)
 *   2. Router unenroll/enroll batches (MAX_ROUTERS_PER_TX each)
 *   3. Gas config unenroll/enroll batches (MAX_GAS_CONFIGS_PER_TX each)
 *   4. Ownership transfer (always last, own tx)
 *
 * @param label - Prefix used for transaction annotations,
 *                e.g. "native token <programId>"
 */
export async function computeWarpTokenUpdateInstructions(
  current: RawWarpArtifactConfig,
  expected: RawWarpArtifactConfig,
  programId: Address,
  ownerAddress: Address,
  igpProgramId: Address,
  label: string,
): Promise<AnnotatedSvmTransaction[]> {
  const txs: AnnotatedSvmTransaction[] = [];

  // 1. ISM + IGP hook — combined into a single tx (both are small instructions)
  const configInstructions: SvmInstruction[] = [];

  const currentIsm = current.interchainSecurityModule?.deployed?.address;
  const expectedIsm = expected.interchainSecurityModule?.deployed?.address;
  if (!eqOptionalAddress(currentIsm, expectedIsm, eqAddressSol)) {
    configInstructions.push(
      await getTokenSetInterchainSecurityModuleInstruction(
        programId,
        ownerAddress,
        expectedIsm ? parseAddress(expectedIsm) : null,
      ),
    );
  }

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
    configInstructions.push(
      await getTokenSetInterchainGasPaymasterInstruction(
        programId,
        ownerAddress,
        igpValue,
      ),
    );
  }

  if (configInstructions.length > 0) {
    txs.push({
      instructions: configInstructions,
      annotation: `Update ${label}: ISM/hook config`,
    });
  }

  // 2. Router diff — routers and gas configs as independent batched streams
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

  const unenrollRouterBatches = Math.ceil(
    diff.toUnenroll.length / MAX_ROUTERS_PER_TX,
  );
  for (let i = 0; i < diff.toUnenroll.length; i += MAX_ROUTERS_PER_TX) {
    const batch = diff.toUnenroll.slice(i, i + MAX_ROUTERS_PER_TX);
    const batchNum = i / MAX_ROUTERS_PER_TX + 1;
    txs.push({
      instructions: [
        await getTokenEnrollRemoteRoutersInstruction(
          programId,
          ownerAddress,
          batch.map((domain) => ({ domain, router: null })),
        ),
      ],
      annotation: `Update ${label}: unenroll routers${unenrollRouterBatches > 1 ? ` (${batchNum}/${unenrollRouterBatches})` : ''}`,
    });
  }

  const unenrollGasBatches = Math.ceil(
    diff.toUnenroll.length / MAX_GAS_CONFIGS_PER_TX,
  );
  for (let i = 0; i < diff.toUnenroll.length; i += MAX_GAS_CONFIGS_PER_TX) {
    const batch = diff.toUnenroll.slice(i, i + MAX_GAS_CONFIGS_PER_TX);
    const batchNum = i / MAX_GAS_CONFIGS_PER_TX + 1;
    txs.push({
      instructions: [
        await getTokenSetDestinationGasConfigsInstruction(
          programId,
          ownerAddress,
          batch.map((domain) => ({ domain, gas: null })),
        ),
      ],
      annotation: `Update ${label}: unenroll gas configs${unenrollGasBatches > 1 ? ` (${batchNum}/${unenrollGasBatches})` : ''}`,
    });
  }

  const enrollRouterBatches = Math.ceil(
    diff.toEnroll.length / MAX_ROUTERS_PER_TX,
  );
  for (let i = 0; i < diff.toEnroll.length; i += MAX_ROUTERS_PER_TX) {
    const batch = diff.toEnroll.slice(i, i + MAX_ROUTERS_PER_TX);
    const batchNum = i / MAX_ROUTERS_PER_TX + 1;
    txs.push({
      instructions: [
        await getTokenEnrollRemoteRoutersInstruction(
          programId,
          ownerAddress,
          batch.map((e) => ({
            domain: e.domainId,
            router: routerHexToBytes(e.routerAddress),
          })),
        ),
      ],
      annotation: `Update ${label}: enroll routers${enrollRouterBatches > 1 ? ` (${batchNum}/${enrollRouterBatches})` : ''}`,
    });
  }

  const enrollGasBatches = Math.ceil(
    diff.toEnroll.length / MAX_GAS_CONFIGS_PER_TX,
  );
  for (let i = 0; i < diff.toEnroll.length; i += MAX_GAS_CONFIGS_PER_TX) {
    const batch = diff.toEnroll.slice(i, i + MAX_GAS_CONFIGS_PER_TX);
    const batchNum = i / MAX_GAS_CONFIGS_PER_TX + 1;
    txs.push({
      instructions: [
        await getTokenSetDestinationGasConfigsInstruction(
          programId,
          ownerAddress,
          batch.map((e) => ({
            domain: e.domainId,
            gas: BigInt(e.gas),
          })),
        ),
      ],
      annotation: `Update ${label}: enroll gas configs${enrollGasBatches > 1 ? ` (${batchNum}/${enrollGasBatches})` : ''}`,
    });
  }

  // 3. Ownership change — always its own last tx
  if (!eqOptionalAddress(current.owner, expected.owner, eqAddressSol)) {
    txs.push({
      instructions: [
        await getTokenTransferOwnershipInstruction(
          programId,
          ownerAddress,
          expected.owner && !isZeroishAddress(expected.owner)
            ? parseAddress(expected.owner)
            : null,
        ),
      ],
      annotation: `Update ${label}: transfer ownership`,
    });
  }

  return txs;
}
