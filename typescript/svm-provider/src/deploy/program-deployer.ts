import {
  type Address,
  type IAccountMeta,
  type IInstruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';

import type { SvmSigner } from '../signer.js';
import { DEFAULT_COMPUTE_UNITS } from '../tx.js';
import type { SvmReceipt } from '../types.js';

// =============================================================================
// Constants
// =============================================================================

/**
 * BPF Loader v3 program address (Upgradeable Loader).
 */
export const LOADER_V3_PROGRAM_ID =
  'BPFLoaderUpgradeab1e11111111111111111111111' as Address;

/**
 * System program address.
 */
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as Address;

/**
 * Rent sysvar address.
 */
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111' as Address;

/**
 * Clock sysvar address.
 */
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111' as Address;

/**
 * Chunk size for writing program data (~1000 bytes per tx, matching Rust CLI).
 */
// Max transaction size is 1232 bytes. After headers/signatures/accounts, ~880 bytes for data
// (accounting for 16-byte instruction header: discriminator + offset + length prefix).
const WRITE_CHUNK_SIZE = 880;

/**
 * Program data header size (for upgradeable programs).
 * 45 bytes: 4 (enum) + 8 (slot) + 1 (option) + 32 (authority pubkey)
 */
const PROGRAM_DATA_HEADER_SIZE = 45;

// =============================================================================
// Loader V3 Instruction Builders
// =============================================================================

/**
 * Loader V3 instruction discriminators.
 */
const LoaderV3Discriminator = {
  InitializeBuffer: 0,
  Write: 1,
  DeployWithMaxDataLen: 2,
  Upgrade: 3,
  SetAuthority: 4,
  Close: 5,
  ExtendProgram: 6,
  SetAuthorityChecked: 7,
} as const;

/**
 * Creates an InitializeBuffer instruction.
 * Initializes a buffer account for program deployment.
 */
function createInitializeBufferInstruction(
  bufferAccount: Address,
  bufferAuthority: Address,
): IInstruction<typeof LOADER_V3_PROGRAM_ID> {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(
    0,
    LoaderV3Discriminator.InitializeBuffer,
    true,
  );

  const accounts: IAccountMeta[] = [
    { address: bufferAccount, role: 1 }, // writable
    { address: bufferAuthority, role: 0 }, // readonly
  ];

  return {
    programAddress: LOADER_V3_PROGRAM_ID,
    accounts,
    data,
  };
}

/**
 * Creates a Write instruction.
 * Writes program data to a buffer account.
 */
function createWriteInstruction(
  bufferAccount: Address,
  bufferAuthority: KeyPairSigner,
  offset: number,
  bytes: Uint8Array,
): IInstruction<typeof LOADER_V3_PROGRAM_ID> {
  // Data layout: [discriminator(u32), offset(u32), bytes_len(u64), bytes...]
  const data = new Uint8Array(16 + bytes.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, LoaderV3Discriminator.Write, true);
  view.setUint32(4, offset, true);
  view.setBigUint64(8, BigInt(bytes.length), true); // Length prefix
  data.set(bytes, 16);

  const accounts: IAccountMeta[] = [
    { address: bufferAccount, role: 1 }, // writable
    { address: bufferAuthority.address, role: 2 }, // signer
  ];

  return {
    programAddress: LOADER_V3_PROGRAM_ID,
    accounts,
    data,
  };
}

/**
 * Creates a DeployWithMaxDataLen instruction.
 * Deploys a program from a buffer account.
 */
function createDeployWithMaxDataLenInstruction(
  payer: KeyPairSigner,
  programDataAccount: Address,
  programAccount: Address,
  bufferAccount: Address,
  authority: KeyPairSigner,
  maxDataLen: bigint,
): IInstruction<typeof LOADER_V3_PROGRAM_ID> {
  // Data layout: [discriminator(u32), maxDataLen(u64)]
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, LoaderV3Discriminator.DeployWithMaxDataLen, true);
  view.setBigUint64(4, maxDataLen, true);

  const accounts: IAccountMeta[] = [
    { address: payer.address, role: 3 }, // writable signer
    { address: programDataAccount, role: 1 }, // writable
    { address: programAccount, role: 1 }, // writable
    { address: bufferAccount, role: 1 }, // writable
    { address: RENT_SYSVAR, role: 0 }, // readonly
    { address: CLOCK_SYSVAR, role: 0 }, // readonly
    { address: SYSTEM_PROGRAM_ID, role: 0 }, // readonly
    { address: authority.address, role: 2 }, // signer
  ];

  return {
    programAddress: LOADER_V3_PROGRAM_ID,
    accounts,
    data,
  };
}

/**
 * Creates an Upgrade instruction.
 * Upgrades an existing program with new data from a buffer.
 */
function createUpgradeInstruction(
  programDataAccount: Address,
  programAccount: Address,
  bufferAccount: Address,
  spillAccount: Address,
  authority: KeyPairSigner,
): IInstruction<typeof LOADER_V3_PROGRAM_ID> {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, LoaderV3Discriminator.Upgrade, true);

  const accounts: IAccountMeta[] = [
    { address: programDataAccount, role: 1 }, // writable
    { address: programAccount, role: 1 }, // writable
    { address: bufferAccount, role: 1 }, // writable
    { address: spillAccount, role: 1 }, // writable (receives rent refund)
    { address: RENT_SYSVAR, role: 0 }, // readonly
    { address: CLOCK_SYSVAR, role: 0 }, // readonly
    { address: authority.address, role: 2 }, // signer
  ];

  return {
    programAddress: LOADER_V3_PROGRAM_ID,
    accounts,
    data,
  };
}

// =============================================================================
// System Program Instructions
// =============================================================================

/**
 * Creates a CreateAccount instruction from the System program.
 */
function createCreateAccountInstruction(
  payer: KeyPairSigner,
  newAccount: KeyPairSigner,
  lamports: bigint,
  space: bigint,
  owner: Address,
): IInstruction<typeof SYSTEM_PROGRAM_ID> {
  // System program CreateAccount discriminator is 0
  // Data layout: [discriminator(u32), lamports(u64), space(u64), owner(pubkey)]
  const addressEncoder = getAddressEncoder();
  const ownerBytes = addressEncoder.encode(owner);

  const data = new Uint8Array(4 + 8 + 8 + 32);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0, true); // CreateAccount discriminator
  view.setBigUint64(4, lamports, true);
  view.setBigUint64(12, space, true);
  data.set(ownerBytes, 20);

  const accounts: IAccountMeta[] = [
    { address: payer.address, role: 3 }, // writable signer
    { address: newAccount.address, role: 3 }, // writable signer
  ];

  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts,
    data,
  };
}

// =============================================================================
// PDA Derivation
// =============================================================================

/**
 * Derives the program data account address for an upgradeable program.
 */
async function getProgramDataAddress(
  programId: Address,
): Promise<{ address: Address; bump: number }> {
  const pda = await getProgramDerivedAddress({
    programAddress: LOADER_V3_PROGRAM_ID,
    seeds: [getAddressEncoder().encode(programId)],
  });
  return { address: pda[0], bump: pda[1] };
}

// =============================================================================
// Rent Calculation
// =============================================================================

/**
 * Gets the minimum rent-exempt balance for an account.
 */
async function getMinimumBalanceForRentExemption(
  rpc: Rpc<SolanaRpcApi>,
  size: number,
): Promise<bigint> {
  const result = await rpc
    .getMinimumBalanceForRentExemption(BigInt(size))
    .send();
  return result;
}

// =============================================================================
// Program Deployment
// =============================================================================

export interface DeployProgramParams {
  /** RPC client */
  rpc: Rpc<SolanaRpcApi>;
  /** Signer for paying and signing transactions */
  signer: SvmSigner;
  /** Program binary (.so file contents) */
  programBytes: Uint8Array;
  /** Optional keypair for the program account (generates if not provided) */
  programKeypair?: KeyPairSigner;
  /** Optional upgrade authority (defaults to signer) */
  upgradeAuthority?: KeyPairSigner;
}

export interface DeployProgramResult {
  /** Deployed program ID */
  programId: Address;
  /** Program data account address */
  programDataAddress: Address;
  /** Transaction receipts */
  receipts: SvmReceipt[];
}

/**
 * Deploys a program to Solana using BPF Loader v3 (Upgradeable Loader).
 *
 * Deployment flow:
 * 1. Create buffer account (rent-exempt size = program bytes + header)
 * 2. Initialize buffer
 * 3. Write program bytes in chunks (~1000 bytes per tx)
 * 4. Deploy from buffer with maxDataLen
 */
export async function deployProgram(
  params: DeployProgramParams,
): Promise<DeployProgramResult> {
  const { rpc, signer, programBytes, programKeypair, upgradeAuthority } =
    params;

  const receipts: SvmReceipt[] = [];

  // Generate program keypair if not provided
  const programKp = programKeypair ?? (await generateKeyPairSigner());
  const authorityKp = upgradeAuthority ?? signer.keypair;

  // Calculate buffer size (program bytes + header)
  const bufferSize = PROGRAM_DATA_HEADER_SIZE + programBytes.length;

  // Generate buffer account keypair
  const bufferKeypair = await generateKeyPairSigner();

  // Get rent for buffer account
  const bufferRent = await getMinimumBalanceForRentExemption(rpc, bufferSize);

  // Step 1: Create buffer account
  const createBufferIx = createCreateAccountInstruction(
    signer.keypair,
    bufferKeypair,
    bufferRent,
    BigInt(bufferSize),
    LOADER_V3_PROGRAM_ID,
  );

  // Step 2: Initialize buffer
  const initBufferIx = createInitializeBufferInstruction(
    bufferKeypair.address,
    authorityKp.address,
  );

  // Send create + init in one transaction (buffer keypair must sign)
  const createInitReceipt = await signer.signAndSend(rpc, {
    instructions: [createBufferIx, initBufferIx],
    computeUnits: DEFAULT_COMPUTE_UNITS,
    additionalSigners: [bufferKeypair.keyPair],
  });
  receipts.push(createInitReceipt);

  // Step 3: Write program bytes in chunks
  let offset = 0;
  while (offset < programBytes.length) {
    const chunk = programBytes.slice(offset, offset + WRITE_CHUNK_SIZE);
    const writeIx = createWriteInstruction(
      bufferKeypair.address,
      authorityKp,
      offset,
      chunk,
    );

    const writeReceipt = await signer.signAndSend(rpc, {
      instructions: [writeIx],
      computeUnits: DEFAULT_COMPUTE_UNITS,
    });
    receipts.push(writeReceipt);

    offset += chunk.length;
  }

  // Step 4: Get program data address (PDA)
  const { address: programDataAddress } = await getProgramDataAddress(
    programKp.address,
  );

  // Get rent for program account
  const programAccountSize = 36; // Size of upgradeable program account
  const programRent = await getMinimumBalanceForRentExemption(
    rpc,
    programAccountSize,
  );

  // Create program account
  const createProgramIx = createCreateAccountInstruction(
    signer.keypair,
    programKp,
    programRent,
    BigInt(programAccountSize),
    LOADER_V3_PROGRAM_ID,
  );

  // Deploy from buffer
  // maxDataLen should be at least 2x the program size to allow upgrades
  const maxDataLen = BigInt(programBytes.length * 2);
  const deployIx = createDeployWithMaxDataLenInstruction(
    signer.keypair,
    programDataAddress,
    programKp.address,
    bufferKeypair.address,
    authorityKp,
    maxDataLen,
  );

  const deployReceipt = await signer.signAndSend(rpc, {
    instructions: [createProgramIx, deployIx],
    computeUnits: 400_000, // Deploy needs more compute
    additionalSigners: [programKp.keyPair],
  });
  receipts.push(deployReceipt);

  return {
    programId: programKp.address,
    programDataAddress,
    receipts,
  };
}

export interface UpgradeProgramParams {
  /** RPC client */
  rpc: Rpc<SolanaRpcApi>;
  /** Signer for paying and signing transactions */
  signer: SvmSigner;
  /** Program ID to upgrade */
  programId: Address;
  /** New program binary (.so file contents) */
  newProgramBytes: Uint8Array;
  /** Upgrade authority keypair */
  upgradeAuthority: KeyPairSigner;
}

export interface UpgradeProgramResult {
  /** Transaction receipts */
  receipts: SvmReceipt[];
}

/**
 * Upgrades an existing program with new bytecode.
 *
 * Upgrade flow:
 * 1. Create new buffer account
 * 2. Initialize buffer
 * 3. Write new program bytes in chunks
 * 4. Execute upgrade instruction
 */
export async function upgradeProgram(
  params: UpgradeProgramParams,
): Promise<UpgradeProgramResult> {
  const { rpc, signer, programId, newProgramBytes, upgradeAuthority } = params;

  const receipts: SvmReceipt[] = [];

  // Calculate buffer size
  const bufferSize = PROGRAM_DATA_HEADER_SIZE + newProgramBytes.length;

  // Generate buffer account keypair
  const bufferKeypair = await generateKeyPairSigner();

  // Get rent for buffer account
  const bufferRent = await getMinimumBalanceForRentExemption(rpc, bufferSize);

  // Step 1: Create buffer account
  const createBufferIx = createCreateAccountInstruction(
    signer.keypair,
    bufferKeypair,
    bufferRent,
    BigInt(bufferSize),
    LOADER_V3_PROGRAM_ID,
  );

  // Step 2: Initialize buffer
  const initBufferIx = createInitializeBufferInstruction(
    bufferKeypair.address,
    upgradeAuthority.address,
  );

  const createInitReceipt = await signer.signAndSend(rpc, {
    instructions: [createBufferIx, initBufferIx],
    computeUnits: DEFAULT_COMPUTE_UNITS,
  });
  receipts.push(createInitReceipt);

  // Step 3: Write new program bytes in chunks
  let offset = 0;
  while (offset < newProgramBytes.length) {
    const chunk = newProgramBytes.slice(offset, offset + WRITE_CHUNK_SIZE);
    const writeIx = createWriteInstruction(
      bufferKeypair.address,
      upgradeAuthority,
      offset,
      chunk,
    );

    const writeReceipt = await signer.signAndSend(rpc, {
      instructions: [writeIx],
      computeUnits: DEFAULT_COMPUTE_UNITS,
    });
    receipts.push(writeReceipt);

    offset += chunk.length;
  }

  // Step 4: Get program data address
  const { address: programDataAddress } =
    await getProgramDataAddress(programId);

  // Execute upgrade
  const upgradeIx = createUpgradeInstruction(
    programDataAddress,
    programId,
    bufferKeypair.address,
    signer.address, // Spill account receives rent refund from buffer
    upgradeAuthority,
  );

  const upgradeReceipt = await signer.signAndSend(rpc, {
    instructions: [upgradeIx],
    computeUnits: 400_000, // Upgrade needs more compute
  });
  receipts.push(upgradeReceipt);

  return { receipts };
}

// Note: To load program bytes from a file in Node.js, use:
// import { readFile } from 'fs/promises';
// const bytes = new Uint8Array(await readFile('program.so'));
