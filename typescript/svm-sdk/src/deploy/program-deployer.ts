import {
  getDeployWithMaxDataLenInstruction,
  getInitializeBufferInstruction,
  getUpgradeInstruction,
  getWriteInstruction,
} from '@solana-program/loader-v3';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  generateKeyPairSigner,
  getAddressCodec,
  getAddressDecoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';

import { LOADER_V3_PROGRAM_ADDRESS } from '../constants.js';
import { DEFAULT_WRITE_CHUNK_SIZE } from '../tx.js';
import type { SvmReceipt, SvmRpc } from '../types.js';

const ADDRESS_CODEC = getAddressCodec();
const BUFFER_METADATA_SIZE = 37;
const PROGRAM_ACCOUNT_SIZE = 36;

export interface DeployProgramPlan {
  programAddress: Address;
  programDataAddress: Address;
  stages: DeployStage[];
}

export interface DeployStage {
  label: string;
  instructions: Instruction[];
  additionalSigners?: TransactionSigner[];
}

export interface DeployProgramPlanArgs {
  payer: TransactionSigner;
  authority?: TransactionSigner;
  programBytes: Uint8Array;
  getMinimumBalanceForRentExemption: (size: number) => Promise<bigint>;
  writeChunkSize?: number;
  maxDataLen?: bigint;
  programSigner?: TransactionSigner;
  bufferSigner?: TransactionSigner;
}

export interface ExecutePlanArgs {
  plan: DeployProgramPlan;
  executeStage: (stage: DeployStage) => Promise<SvmReceipt>;
}

export interface UpgradeProgramPlanArgs {
  payer: TransactionSigner;
  authority: TransactionSigner;
  programAddress: Address;
  newProgramBytes: Uint8Array;
  getMinimumBalanceForRentExemption: (size: number) => Promise<bigint>;
  writeChunkSize?: number;
  bufferSigner?: TransactionSigner;
}

export async function createDeployProgramPlan(
  args: DeployProgramPlanArgs,
): Promise<DeployProgramPlan> {
  const authority = args.authority ?? args.payer;
  const programSigner = args.programSigner ?? (await generateKeyPairSigner());
  const bufferSigner = args.bufferSigner ?? (await generateKeyPairSigner());

  const chunkSize = args.writeChunkSize ?? DEFAULT_WRITE_CHUNK_SIZE;
  const maxDataLen = args.maxDataLen ?? BigInt(args.programBytes.length * 2);

  const bufferSize = BUFFER_METADATA_SIZE + args.programBytes.length;
  const bufferRent = await args.getMinimumBalanceForRentExemption(bufferSize);
  const programRent =
    await args.getMinimumBalanceForRentExemption(PROGRAM_ACCOUNT_SIZE);

  const programDataAddress = await deriveProgramDataAddress(
    programSigner.address,
  );

  const createBufferInstruction = getCreateAccountInstruction({
    payer: args.payer,
    newAccount: bufferSigner,
    lamports: bufferRent,
    space: BigInt(bufferSize),
    programAddress: LOADER_V3_PROGRAM_ADDRESS,
  });

  const initializeBufferInstruction = getInitializeBufferInstruction({
    sourceAccount: bufferSigner.address,
    bufferAuthority: authority.address,
  });

  const stages: DeployStage[] = [
    {
      label: 'create-and-init-buffer',
      instructions: [createBufferInstruction, initializeBufferInstruction],
      additionalSigners: [bufferSigner],
    },
  ];

  for (let offset = 0; offset < args.programBytes.length; offset += chunkSize) {
    const bytes = args.programBytes.slice(offset, offset + chunkSize);
    stages.push({
      label: `write-${offset}`,
      instructions: [
        getWriteInstruction({
          bufferAccount: bufferSigner.address,
          bufferAuthority: authority,
          offset,
          bytes,
        }),
      ],
    });
  }

  const createProgramInstruction = getCreateAccountInstruction({
    payer: args.payer,
    newAccount: programSigner,
    lamports: programRent,
    space: BigInt(PROGRAM_ACCOUNT_SIZE),
    programAddress: LOADER_V3_PROGRAM_ADDRESS,
  });

  const deployInstruction = getDeployWithMaxDataLenInstruction({
    payerAccount: args.payer,
    programDataAccount: programDataAddress,
    programAccount: programSigner.address,
    bufferAccount: bufferSigner.address,
    authority,
    maxDataLen,
  });

  stages.push({
    label: 'create-and-deploy-program',
    instructions: [createProgramInstruction, deployInstruction],
    additionalSigners: [programSigner],
  });

  return {
    programAddress: programSigner.address,
    programDataAddress,
    stages,
  };
}

export async function createUpgradeProgramPlan(
  args: UpgradeProgramPlanArgs,
): Promise<DeployProgramPlan> {
  const bufferSigner = args.bufferSigner ?? (await generateKeyPairSigner());
  const chunkSize = args.writeChunkSize ?? DEFAULT_WRITE_CHUNK_SIZE;

  const bufferSize = BUFFER_METADATA_SIZE + args.newProgramBytes.length;
  const bufferRent = await args.getMinimumBalanceForRentExemption(bufferSize);
  const programDataAddress = await deriveProgramDataAddress(
    args.programAddress,
  );

  const stages: DeployStage[] = [
    {
      label: 'create-and-init-buffer',
      instructions: [
        getCreateAccountInstruction({
          payer: args.payer,
          newAccount: bufferSigner,
          lamports: bufferRent,
          space: BigInt(bufferSize),
          programAddress: LOADER_V3_PROGRAM_ADDRESS,
        }),
        getInitializeBufferInstruction({
          sourceAccount: bufferSigner.address,
          bufferAuthority: args.authority.address,
        }),
      ],
      additionalSigners: [bufferSigner],
    },
  ];

  for (
    let offset = 0;
    offset < args.newProgramBytes.length;
    offset += chunkSize
  ) {
    const bytes = args.newProgramBytes.slice(offset, offset + chunkSize);
    stages.push({
      label: `write-${offset}`,
      instructions: [
        getWriteInstruction({
          bufferAccount: bufferSigner.address,
          bufferAuthority: args.authority,
          offset,
          bytes,
        }),
      ],
    });
  }

  stages.push({
    label: 'upgrade-program',
    instructions: [
      getUpgradeInstruction({
        programDataAccount: programDataAddress,
        programAccount: args.programAddress,
        bufferAccount: bufferSigner.address,
        spillAccount: args.payer.address,
        authority: args.authority,
      }),
    ],
  });

  return {
    programAddress: args.programAddress,
    programDataAddress,
    stages,
  };
}

export async function executeDeployPlan(
  args: ExecutePlanArgs,
): Promise<SvmReceipt[]> {
  const receipts: SvmReceipt[] = [];
  for (const stage of args.plan.stages) {
    receipts.push(await args.executeStage(stage));
  }
  return receipts;
}

export async function deriveProgramDataAddress(
  programAddress: Address,
): Promise<Address> {
  const pda = await getProgramDerivedAddress({
    programAddress: LOADER_V3_PROGRAM_ADDRESS,
    seeds: [ADDRESS_CODEC.encode(programAddress)],
  });
  return pda[0];
}

/**
 * Reads the BPF loader upgradeable ProgramData account to return the current
 * upgrade authority, or null if the program is immutable or not found.
 *
 * ProgramData binary layout:
 *   [0-3]  u32 discriminant (= 3)
 *   [4-11] u64 slot
 *   [12]   u8  option tag (0 = None, 1 = Some)
 *   [13-44] [u8; 32] upgrade authority pubkey (only when tag = 1)
 */
export async function getProgramUpgradeAuthority(
  rpc: SvmRpc,
  programAddress: Address,
): Promise<Address | null> {
  const programDataAddress = await deriveProgramDataAddress(programAddress);
  const account = await rpc
    .getAccountInfo(programDataAddress, { encoding: 'base64' })
    .send();
  if (!account.value) return null;
  const data = Buffer.from(account.value.data[0] as string, 'base64');
  if (data.length < 45) return null;
  const hasAuthority = data[12] === 1;
  if (!hasAuthority) return null;
  return getAddressDecoder().decode(data.slice(13, 45));
}
