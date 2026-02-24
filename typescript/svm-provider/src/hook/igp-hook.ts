import {
  address as parseAddress,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { keccak_256 } from '@noble/hashes/sha3';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { IgpHookConfig } from '@hyperlane-xyz/provider-sdk/hook';

import type { GasOracleConfig, GasOverheadConfig } from '../codecs/shared.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitIgpInstruction,
  getInitIgpProgramInstruction,
  getInitOverheadIgpInstruction,
  getSetDestinationGasOverheadsInstruction,
  getSetGasOracleConfigsInstruction,
} from '../instructions/igp.js';
import { deriveIgpAccountPda, deriveOverheadIgpAccountPda } from '../pda.js';
import type { SvmSigner } from '../signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedIgpHook,
  SvmProgramTarget,
  SvmReceipt,
} from '../types.js';

import {
  fetchIgpAccount,
  fetchIgpProgramData,
  fetchOverheadIgpAccount,
  remoteGasDataToConfig,
} from './hook-query.js';

export interface SvmIgpHookConfig extends IgpHookConfig {
  program: SvmProgramTarget;
  context?: string;
}

export function deriveIgpSalt(context: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(context));
}

export const DEFAULT_IGP_CONTEXT = 'hyperlane_igp';

export class SvmIgpHookReader implements ArtifactReader<
  IgpHookConfig,
  SvmDeployedIgpHook
> {
  constructor(
    protected readonly rpc: Rpc<SolanaRpcApi>,
    protected readonly salt: Uint8Array,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<IgpHookConfig, SvmDeployedIgpHook>> {
    const programId = parseAddress(address);
    const igp = await fetchIgpAccount(this.rpc, programId, this.salt);
    if (!igp) {
      throw new Error(`IGP account not found for program: ${programId}`);
    }

    const overheadIgp = await fetchOverheadIgpAccount(
      this.rpc,
      programId,
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

    const owner = igp.owner ?? '';
    const beneficiary = igp.beneficiary;

    const { address: igpPda } = await deriveIgpAccountPda(programId, this.salt);
    const { address: overheadIgpPda } = await deriveOverheadIgpAccountPda(
      programId,
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
      deployed: {
        address: igpPda,
        programId,
        igpPda,
        overheadIgpPda: overheadIgp ? overheadIgpPda : undefined,
      },
    };
  }
}

export class SvmIgpHookWriter
  extends SvmIgpHookReader
  implements ArtifactWriter<IgpHookConfig, SvmDeployedIgpHook>
{
  constructor(
    rpc: Rpc<SolanaRpcApi>,
    salt: Uint8Array,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc, salt);
  }

  async create(
    artifact: ArtifactNew<IgpHookConfig>,
  ): Promise<
    [ArtifactDeployed<IgpHookConfig, SvmDeployedIgpHook>, SvmReceipt[]]
  > {
    const config = artifact.config as SvmIgpHookConfig;
    const { programAddress: programId, receipts } = await resolveProgram(
      config.program,
      this.svmSigner,
      this.rpc,
    );

    // Phase 1: Initialize program data PDA if not yet created
    const programData = await fetchIgpProgramData(this.rpc, programId);
    if (!programData) {
      const initProgramIx = await getInitIgpProgramInstruction(
        programId,
        this.svmSigner.signer,
      );
      const initProgramReceipt = await this.svmSigner.send({
        instructions: [initProgramIx],
      });
      receipts.push(initProgramReceipt);
    }

    // Phase 2: Initialize specific IGP account
    let igp = await fetchIgpAccount(this.rpc, programId, this.salt);

    if (!igp) {
      const initIgpIx = await getInitIgpInstruction(
        programId,
        this.svmSigner.signer,
        {
          salt: this.salt,
          owner: config.owner ? parseAddress(config.owner) : null,
          beneficiary: parseAddress(config.beneficiary),
        },
      );

      const initReceipt = await this.svmSigner.send({
        instructions: [initIgpIx],
      });
      receipts.push(initReceipt);

      igp = await fetchIgpAccount(this.rpc, programId, this.salt);
    }

    const { address: igpPda } = await deriveIgpAccountPda(programId, this.salt);

    const overheadIgp = await fetchOverheadIgpAccount(
      this.rpc,
      programId,
      this.salt,
    );

    let overheadIgpPda: Address | undefined;

    if (!overheadIgp && Object.keys(config.overhead).length > 0) {
      const initOverheadIx = await getInitOverheadIgpInstruction(
        programId,
        this.svmSigner.signer,
        {
          salt: this.salt,
          owner: config.owner ? parseAddress(config.owner) : null,
          inner: igpPda,
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
        programId,
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
      const derivedOverheadPda = await deriveOverheadIgpAccountPda(
        programId,
        this.salt,
      );
      overheadIgpPda = derivedOverheadPda.address;

      const setOverheadIx = await getSetDestinationGasOverheadsInstruction(
        programId,
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
        deployed: {
          address: igpPda,
          programId,
          igpPda,
          overheadIgpPda,
        },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<IgpHookConfig, SvmDeployedIgpHook>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const txs: AnnotatedSvmTransaction[] = [];
    const config = artifact.config;
    const programId = artifact.deployed.programId;

    const currentIgp = await fetchIgpAccount(this.rpc, programId, this.salt);
    if (!currentIgp) {
      throw new Error('IGP account not initialized');
    }

    const { address: igpPda } = await deriveIgpAccountPda(programId, this.salt);

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
        programId,
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
      programId,
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
        programId,
        this.salt,
      );

      const setOverheadIx = await getSetDestinationGasOverheadsInstruction(
        programId,
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
