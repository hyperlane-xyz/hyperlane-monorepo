import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { keccak_256 } from '@noble/hashes/sha3';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedHookAddress,
  IgpHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';

import type { GasOracleConfig, GasOverheadConfig } from '../codecs/shared.js';
import {
  getInitIgpInstruction,
  getInitIgpProgramInstruction,
  getInitOverheadIgpInstruction,
  getSetDestinationGasOverheadsInstruction,
  getSetGasOracleConfigsInstruction,
} from '../instructions/igp.js';
import { deriveIgpAccountPda, deriveOverheadIgpAccountPda } from '../pda.js';
import type { SvmSigner } from '../signer.js';
import type { AnnotatedSvmTransaction, SvmReceipt } from '../types.js';

import {
  fetchIgpAccount,
  fetchIgpProgramData,
  fetchOverheadIgpAccount,
  remoteGasDataToConfig,
} from './hook-query.js';

export interface SvmIgpHookConfig extends IgpHookConfig {
  context?: string;
}

export function deriveIgpSalt(context: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(context));
}

export const DEFAULT_IGP_CONTEXT = 'hyperlane_igp';

export class SvmIgpHookReader implements ArtifactReader<
  IgpHookConfig,
  DeployedHookAddress
> {
  constructor(
    protected readonly rpc: Rpc<SolanaRpcApi>,
    protected readonly programId: Address,
    protected readonly salt: Uint8Array,
  ) {}

  async read(
    _address: string,
  ): Promise<ArtifactDeployed<IgpHookConfig, DeployedHookAddress>> {
    const igp = await fetchIgpAccount(this.rpc, this.programId, this.salt);
    if (!igp) {
      throw new Error(`IGP account not found for program: ${this.programId}`);
    }

    const overheadIgp = await fetchOverheadIgpAccount(
      this.rpc,
      this.programId,
      this.salt,
    );

    const oracleConfig: Record<
      number,
      { gasPrice: string; tokenExchangeRate: string; tokenDecimals?: number }
    > = {};
    for (const [domain, oracle] of igp.gasOracles.entries()) {
      oracleConfig[domain] = remoteGasDataToConfig(oracle);
    }

    const overhead: Record<number, number> = {};
    if (overheadIgp) {
      for (const [domain, gas] of overheadIgp.gasOverheads.entries()) {
        overhead[domain] = Number(gas);
      }
    }

    // FIXME we keep converting addresses with Buffer.toString()
    // our account data declares them as Uint8Array, but in Rust the type is PubKey
    // should we use string address types in account data and updated our codecs?
    // FIY, there is a getBase16Codec() in @solana/codec-strings
    const owner = igp.owner ? Buffer.from(igp.owner).toString('hex') : '';
    const beneficiary = Buffer.from(igp.beneficiary).toString('hex');

    const { address: igpPda } = await deriveIgpAccountPda(
      this.programId,
      this.salt,
    );

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: HookType.INTERCHAIN_GAS_PAYMASTER as 'interchainGasPaymaster',
        owner,
        beneficiary,
        oracleKey: owner,
        overhead,
        oracleConfig,
      },
      deployed: { address: igpPda },
    };
  }
}

export class SvmIgpHookWriter
  extends SvmIgpHookReader
  implements ArtifactWriter<IgpHookConfig, DeployedHookAddress>
{
  constructor(
    rpc: Rpc<SolanaRpcApi>,
    programId: Address,
    salt: Uint8Array,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc, programId, salt);
  }

  async create(
    artifact: ArtifactNew<IgpHookConfig>,
  ): Promise<
    [ArtifactDeployed<IgpHookConfig, DeployedHookAddress>, SvmReceipt[]]
  > {
    const receipts: SvmReceipt[] = [];
    const config = artifact.config;

    // Phase 1: Initialize program data PDA if not yet created
    const programData = await fetchIgpProgramData(this.rpc, this.programId);
    if (!programData) {
      const initProgramIx = await getInitIgpProgramInstruction(
        this.programId,
        this.svmSigner.signer,
      );
      const initProgramReceipt = await this.svmSigner.send({
        instructions: [initProgramIx],
      });
      receipts.push(initProgramReceipt);
    }

    // Phase 2: Initialize specific IGP account
    let igp = await fetchIgpAccount(this.rpc, this.programId, this.salt);

    if (!igp) {
      const ownerBytes = config.owner
        ? addressToBytes32(config.owner as Address)
        : null;
      const beneficiaryBytes = addressToBytes32(config.beneficiary as Address);

      const initIgpIx = await getInitIgpInstruction(
        this.programId,
        this.svmSigner.signer,
        {
          salt: this.salt,
          owner: ownerBytes,
          beneficiary: beneficiaryBytes,
        },
      );

      const initReceipt = await this.svmSigner.send({
        instructions: [initIgpIx],
      });
      receipts.push(initReceipt);

      igp = await fetchIgpAccount(this.rpc, this.programId, this.salt);
    }

    const { address: igpPda } = await deriveIgpAccountPda(
      this.programId,
      this.salt,
    );

    const overheadIgp = await fetchOverheadIgpAccount(
      this.rpc,
      this.programId,
      this.salt,
    );

    if (!overheadIgp && Object.keys(config.overhead).length > 0) {
      const ownerBytes = config.owner
        ? addressToBytes32(config.owner as Address)
        : null;
      const innerBytes = addressToBytes32(igpPda);

      const initOverheadIx = await getInitOverheadIgpInstruction(
        this.programId,
        this.svmSigner.signer,
        {
          salt: this.salt,
          owner: ownerBytes,
          inner: innerBytes,
        },
      );

      const initOverheadReceipt = await this.svmSigner.send({
        instructions: [initOverheadIx],
      });
      receipts.push(initOverheadReceipt);
    }

    const oracleConfigs: GasOracleConfig[] = Object.entries(
      config.oracleConfig,
    ).map(([domainStr, oracleData]) => ({
      domain: parseInt(domainStr),
      gasOracle: {
        kind: 0 as const,
        value: {
          gasPrice: BigInt(oracleData.gasPrice),
          tokenExchangeRate: BigInt(oracleData.tokenExchangeRate),
          tokenDecimals: oracleData.tokenDecimals ?? 9,
        },
      },
    }));

    if (oracleConfigs.length > 0) {
      const setOracleIx = await getSetGasOracleConfigsInstruction(
        this.programId,
        this.svmSigner.signer,
        igpPda,
        oracleConfigs,
      );

      const oracleReceipt = await this.svmSigner.send({
        instructions: [setOracleIx],
      });
      receipts.push(oracleReceipt);
    }

    const overheadConfigs: GasOverheadConfig[] = Object.entries(
      config.overhead,
    ).map(([domainStr, gas]) => ({
      destinationDomain: parseInt(domainStr),
      gasOverhead: BigInt(gas),
    }));

    if (overheadConfigs.length > 0) {
      const { address: overheadIgpPda } = await deriveOverheadIgpAccountPda(
        this.programId,
        this.salt,
      );

      const setOverheadIx = await getSetDestinationGasOverheadsInstruction(
        this.programId,
        this.svmSigner.signer,
        overheadIgpPda,
        overheadConfigs,
      );

      const overheadReceipt = await this.svmSigner.send({
        instructions: [setOverheadIx],
      });
      receipts.push(overheadReceipt);
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: config,
        deployed: { address: igpPda },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<IgpHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const txs: AnnotatedSvmTransaction[] = [];
    const config = artifact.config;

    const currentIgp = await fetchIgpAccount(
      this.rpc,
      this.programId,
      this.salt,
    );
    if (!currentIgp) {
      throw new Error('IGP account not initialized');
    }

    const { address: igpPda } = await deriveIgpAccountPda(
      this.programId,
      this.salt,
    );

    const oracleConfigsToUpdate: GasOracleConfig[] = [];
    for (const [domainStr, oracleData] of Object.entries(config.oracleConfig)) {
      const domain = parseInt(domainStr);
      const existingOracle = currentIgp.gasOracles.get(domain);

      const newGasPrice = BigInt(oracleData.gasPrice);
      const newTokenExchangeRate = BigInt(oracleData.tokenExchangeRate);
      const newTokenDecimals = oracleData.tokenDecimals ?? 9;

      let needsUpdate = false;
      if (!existingOracle) {
        needsUpdate = true;
      } else {
        const existing = existingOracle.value;
        if (
          existing.gasPrice !== newGasPrice ||
          existing.tokenExchangeRate !== newTokenExchangeRate ||
          existing.tokenDecimals !== newTokenDecimals
        ) {
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        oracleConfigsToUpdate.push({
          domain,
          gasOracle: {
            kind: 0,
            value: {
              gasPrice: newGasPrice,
              tokenExchangeRate: newTokenExchangeRate,
              tokenDecimals: newTokenDecimals,
            },
          },
        });
      }
    }

    if (oracleConfigsToUpdate.length > 0) {
      const setOracleIx = await getSetGasOracleConfigsInstruction(
        this.programId,
        this.svmSigner.signer,
        igpPda,
        oracleConfigsToUpdate,
      );

      txs.push({
        instructions: [setOracleIx],
        annotation: `Update gas oracles for ${oracleConfigsToUpdate.length} domains`,
      });
    }

    const currentOverheadIgp = await fetchOverheadIgpAccount(
      this.rpc,
      this.programId,
      this.salt,
    );

    const overheadConfigsToUpdate: GasOverheadConfig[] = [];
    for (const [domainStr, gas] of Object.entries(config.overhead)) {
      const domain = parseInt(domainStr);
      const existingOverhead = currentOverheadIgp?.gasOverheads.get(domain);
      const newOverhead = BigInt(gas);

      if (!existingOverhead || existingOverhead !== newOverhead) {
        overheadConfigsToUpdate.push({
          destinationDomain: domain,
          gasOverhead: newOverhead,
        });
      }
    }

    if (overheadConfigsToUpdate.length > 0) {
      const { address: overheadIgpPda } = await deriveOverheadIgpAccountPda(
        this.programId,
        this.salt,
      );

      const setOverheadIx = await getSetDestinationGasOverheadsInstruction(
        this.programId,
        this.svmSigner.signer,
        overheadIgpPda,
        overheadConfigsToUpdate,
      );

      txs.push({
        instructions: [setOverheadIx],
        annotation: `Update gas overheads for ${overheadConfigsToUpdate.length} domains`,
      });
    }

    return txs;
  }
}

function addressToBytes32(address: Address): Uint8Array {
  // Solana addresses are 32-byte base58 - decode to bytes
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58;
  const bytes: number[] = [0];
  for (let i = 0; i < address.length; i++) {
    const value = ALPHABET.indexOf(address[i]);
    if (value === -1)
      throw new Error(`Invalid base58 character: ${address[i]}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * BASE;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < address.length && address[i] === '1'; i++) {
    bytes.push(0);
  }
  const decoded = new Uint8Array(bytes.reverse());
  // Pad to 32 bytes
  const result = new Uint8Array(32);
  result.set(decoded, 32 - decoded.length);
  return result;
}
