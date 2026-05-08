import { address as parseAddress, type Address } from '@solana/kit';
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
import {
  assert,
  isZeroishAddress,
  ZERO_ADDRESS_HEX_32,
} from '@hyperlane-xyz/utils';

import type { GasOracleConfig, GasOverheadConfig } from '../codecs/shared.js';
import { prepareProgramUpgrade } from '../deploy/program-upgrade.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitIgpInstruction,
  getInitIgpProgramInstruction,
  getInitOverheadIgpInstruction,
  getSetDestinationGasOverheadsInstruction,
  getSetGasOracleConfigsInstruction,
} from '../instructions/igp.js';
import { deriveIgpAccountPda, deriveOverheadIgpAccountPda } from '../pda.js';
import type { SvmSigner } from '../clients/signer.js';
import {
  hasProgramBytes,
  type AnnotatedSvmTransaction,
  type SvmDeployedIgpHook,
  type SvmProgramTarget,
  type SvmReceipt,
  type SvmRpc,
} from '../types.js';

import {
  fetchIgpAccount,
  fetchIgpProgramData,
  fetchIgpProgramVersion,
  fetchOverheadIgpAccount,
  remoteGasDataToConfig,
} from './hook-query.js';

/**
 * Deployment-time configuration for the SVM IGP hook writer.
 * Passed to the writer constructor; separate from the on-chain artifact config.
 */
export type SvmIgpHookWriterConfig = Readonly<{
  /** How to obtain the deployed program: fresh bytes or pre-existing ID. */
  program: SvmProgramTarget;
}>;

export function deriveIgpSalt(context: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(context));
}

/** Zero salt — matches mainnet IGP deployments (H256::zero() in Rust). */
export const DEFAULT_IGP_SALT = new Uint8Array(32);

export class SvmIgpHookReader implements ArtifactReader<
  IgpHookConfig,
  SvmDeployedIgpHook
> {
  constructor(
    protected readonly rpc: SvmRpc,
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

    const owner = igp.owner;
    const beneficiary = igp.beneficiary;

    const contractVersion = await fetchIgpProgramVersion(
      this.rpc,
      programId,
      owner ?? null,
    );

    const { address: igpPda } = await deriveIgpAccountPda(programId, this.salt);
    const { address: overheadIgpPda } = await deriveOverheadIgpAccountPda(
      programId,
      this.salt,
    );

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        // FIXME: address provider sdk type in a separate pr
        owner: owner ?? ZERO_ADDRESS_HEX_32,
        beneficiary,
        // FIXME: address provider sdk type in a separate pr
        oracleKey: owner ?? ZERO_ADDRESS_HEX_32,
        overhead,
        oracleConfig,
        contractVersion: contractVersion ?? undefined,
        quoteSigners: igp.feeConfig?.signers,
      },
      deployed: {
        address: programId,
        programId,
        igpPda,
        overheadIgpPda: overheadIgp ? overheadIgpPda : undefined,
        feeConfig: igp.feeConfig,
      },
    };
  }
}

export class SvmIgpHookWriter
  extends SvmIgpHookReader
  implements ArtifactWriter<IgpHookConfig, SvmDeployedIgpHook>
{
  constructor(
    private readonly config: SvmIgpHookWriterConfig,
    rpc: SvmRpc,
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
    const config = artifact.config;
    const { programAddress: programId, receipts } = await resolveProgram(
      this.config.program,
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
        skipPreflight: true,
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
        skipPreflight: true,
      });
      receipts.push(initReceipt);

      igp = await fetchIgpAccount(this.rpc, programId, this.salt);
      assert(igp, 'IGP account not found after init');
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
        skipPreflight: true,
      });
      receipts.push(initOverheadReceipt);
    }

    const oracleConfigs: GasOracleConfig[] = Object.entries(
      config.oracleConfig,
    ).map(([domainStr, oracleData]) => {
      const domain = Number(domainStr);
      assert(
        Number.isInteger(domain) && domain >= 0,
        `Invalid domain: '${domainStr}'`,
      );
      return {
        domain,
        gasOracle: {
          kind: 0 as const,
          value: {
            gasPrice: BigInt(oracleData.gasPrice),
            tokenExchangeRate: BigInt(oracleData.tokenExchangeRate),
            tokenDecimals: oracleData.tokenDecimals ?? 9,
          },
        },
      };
    });

    if (oracleConfigs.length > 0) {
      const setOracleIx = await getSetGasOracleConfigsInstruction(
        programId,
        this.svmSigner.signer.address,
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
    ).map(([domainStr, gas]) => {
      const domain = Number(domainStr);
      assert(
        Number.isInteger(domain) && domain >= 0,
        `Invalid domain: '${domainStr}'`,
      );
      return {
        destinationDomain: domain,
        gasOverhead: BigInt(gas),
      };
    });

    if (overheadConfigs.length > 0) {
      const derivedOverheadPda = await deriveOverheadIgpAccountPda(
        programId,
        this.salt,
      );
      overheadIgpPda = derivedOverheadPda.address;

      const setOverheadIx = await getSetDestinationGasOverheadsInstruction(
        programId,
        this.svmSigner.signer.address,
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
          address: programId,
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

    const current = await this.read(programId);
    assert(
      !isZeroishAddress(current.config.owner),
      `Cannot update IGP ${programId}: IGP has no owner`,
    );
    const ownerAddress = parseAddress(current.config.owner);
    const igpPda = current.deployed.igpPda;

    if (hasProgramBytes(this.config.program)) {
      const upgradeResult = await prepareProgramUpgrade(
        programId,
        current.config.contractVersion,
        config.contractVersion,
        this.config.program.programBytes,
        this.svmSigner,
        this.rpc,
        `igp ${programId}`,
      );

      txs.push(...(upgradeResult?.authorityTransactions ?? []));
    }

    const oracleConfigsToUpdate: GasOracleConfig[] = [];
    for (const [domainStr, oracleData] of Object.entries(config.oracleConfig)) {
      const domain = Number(domainStr);
      assert(
        Number.isInteger(domain) && domain >= 0,
        `Invalid domain: '${domainStr}'`,
      );
      const existingOracle = current.config.oracleConfig[domain];

      const newGasPrice = BigInt(oracleData.gasPrice);
      const newTokenExchangeRate = BigInt(oracleData.tokenExchangeRate);
      const newTokenDecimals = oracleData.tokenDecimals ?? 9;

      let needsUpdate = false;
      if (!existingOracle) {
        needsUpdate = true;
      } else if (
        BigInt(existingOracle.gasPrice) !== newGasPrice ||
        BigInt(existingOracle.tokenExchangeRate) !== newTokenExchangeRate ||
        (existingOracle.tokenDecimals ?? 9) !== newTokenDecimals
      ) {
        needsUpdate = true;
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
        ownerAddress,
        igpPda,
        oracleConfigsToUpdate,
      );

      txs.push({
        feePayer: ownerAddress,
        instructions: [setOracleIx],
        annotation: `Update gas oracles for ${oracleConfigsToUpdate.length} domains`,
      });
    }

    const overheadIgpPda = current.deployed.overheadIgpPda;
    assert(overheadIgpPda, `Overhead IGP not initialized for ${programId}`);

    const overheadConfigsToUpdate: GasOverheadConfig[] = [];
    for (const [domainStr, gas] of Object.entries(config.overhead)) {
      const domain = Number(domainStr);
      assert(
        Number.isInteger(domain) && domain >= 0,
        `Invalid domain: '${domainStr}'`,
      );
      const existingOverhead = current.config.overhead[domain];
      const newOverhead = BigInt(gas);

      if (
        existingOverhead === undefined ||
        BigInt(existingOverhead) !== newOverhead
      ) {
        overheadConfigsToUpdate.push({
          destinationDomain: domain,
          gasOverhead: newOverhead,
        });
      }
    }

    if (overheadConfigsToUpdate.length > 0) {
      const setOverheadIx = await getSetDestinationGasOverheadsInstruction(
        programId,
        ownerAddress,
        overheadIgpPda,
        overheadConfigsToUpdate,
      );

      txs.push({
        feePayer: ownerAddress,
        instructions: [setOverheadIx],
        annotation: `Update gas overheads for ${overheadConfigsToUpdate.length} domains`,
      });
    }

    return txs;
  }
}
