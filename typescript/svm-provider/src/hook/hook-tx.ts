import type { Address, TransactionSigner } from '@solana/kit';

import { getInitIgpInstruction } from '../generated/instructions/initIgp.js';
import { getInitOverheadIgpInstruction } from '../generated/instructions/initOverheadIgp.js';
import { getSetDestinationGasOverheadsInstruction } from '../generated/instructions/setDestinationGasOverheads.js';
import { getSetGasOracleConfigsInstruction } from '../generated/instructions/setGasOracleConfigs.js';
import { getIgpAccountPda, getOverheadIgpAccountPda } from '../pda.js';
import type { SvmInstruction } from '../types.js';

// =============================================================================
// IGP Instructions
// =============================================================================

/**
 * Creates an instruction to initialize an IGP account.
 *
 * @param params.payer - Payer for account creation
 * @param params.programId - IGP program ID
 * @param params.salt - 32-byte salt for PDA derivation
 * @param params.owner - Owner of the IGP (can be null for no owner)
 * @param params.beneficiary - Beneficiary address for collected fees
 */
export async function getInitIgpAccountInstruction(params: {
  payer: TransactionSigner;
  programId: Address;
  salt: Uint8Array;
  owner: Address | null;
  beneficiary: Address;
}): Promise<SvmInstruction> {
  const { payer, programId, salt, owner, beneficiary } = params;
  const [igpPda] = await getIgpAccountPda(programId, salt);

  return getInitIgpInstruction(
    {
      payer,
      igp: igpPda,
      salt,
      owner,
      beneficiary,
    },
    { programAddress: programId },
  ) as unknown as SvmInstruction;
}

/**
 * Creates an instruction to initialize an Overhead IGP account.
 *
 * @param params.payer - Payer for account creation
 * @param params.programId - IGP program ID
 * @param params.salt - 32-byte salt for PDA derivation
 * @param params.owner - Owner of the overhead IGP (can be null for no owner)
 * @param params.inner - Inner IGP account address
 */
export async function getInitOverheadIgpAccountInstruction(params: {
  payer: TransactionSigner;
  programId: Address;
  salt: Uint8Array;
  owner: Address | null;
  innerIgp: Address;
}): Promise<SvmInstruction> {
  const { payer, programId, salt, owner, innerIgp } = params;
  const [overheadIgpPda] = await getOverheadIgpAccountPda(programId, salt);

  return getInitOverheadIgpInstruction(
    {
      payer,
      overheadIgp: overheadIgpPda,
      salt,
      owner,
      inner: innerIgp,
    },
    { programAddress: programId },
  ) as unknown as SvmInstruction;
}

/**
 * Gas oracle config for a domain.
 */
export interface GasOracleConfigInput {
  domain: number;
  gasPrice: bigint;
  tokenExchangeRate: bigint;
  tokenDecimals: number;
}

/**
 * Creates an instruction to set gas oracle configs for multiple domains.
 *
 * @param params.owner - Owner of the IGP
 * @param params.programId - IGP program ID
 * @param params.igpAccount - IGP account address
 * @param params.configs - Array of gas oracle configs per domain
 */
export async function getSetGasOracleConfigsIx(params: {
  owner: TransactionSigner;
  programId: Address;
  igpAccount: Address;
  configs: GasOracleConfigInput[];
}): Promise<SvmInstruction> {
  const { owner, programId, igpAccount, configs } = params;

  const args = configs.map((c) => ({
    domain: c.domain,
    gasOracle: {
      __kind: 'RemoteGasData' as const,
      fields: [
        {
          tokenExchangeRate: c.tokenExchangeRate,
          gasPrice: c.gasPrice,
          tokenDecimals: c.tokenDecimals,
        },
      ] as const,
    },
  }));

  return getSetGasOracleConfigsInstruction(
    {
      owner,
      igp: igpAccount,
      args,
    },
    { programAddress: programId },
  ) as unknown as SvmInstruction;
}

/**
 * Gas overhead config for a domain.
 */
export interface GasOverheadConfigInput {
  destinationDomain: number;
  gasOverhead: bigint | null;
}

/**
 * Creates an instruction to set destination gas overheads.
 *
 * @param params.owner - Owner of the overhead IGP
 * @param params.programId - IGP program ID
 * @param params.overheadIgpAccount - Overhead IGP account address
 * @param params.configs - Array of gas overhead configs per domain
 */
export async function getSetDestinationGasOverheadsIx(params: {
  owner: TransactionSigner;
  programId: Address;
  overheadIgpAccount: Address;
  configs: GasOverheadConfigInput[];
}): Promise<SvmInstruction> {
  const { owner, programId, overheadIgpAccount, configs } = params;

  const args = configs.map((c) => ({
    destinationDomain: c.destinationDomain,
    gasOverhead: c.gasOverhead,
  }));

  return getSetDestinationGasOverheadsInstruction(
    {
      owner,
      overheadIgp: overheadIgpAccount,
      args,
    },
    { programAddress: programId },
  ) as unknown as SvmInstruction;
}
