import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { keccak256 } from 'viem';

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

import { getIgpAccountPda, getOverheadIgpAccountPda } from '../pda.js';
import type { SvmSigner } from '../signer.js';
import type { AnnotatedSvmTransaction, SvmReceipt } from '../types.js';

import {
  fetchIgpAccount,
  fetchOverheadIgpAccount,
  remoteGasDataToConfig,
} from './hook-query.js';
import {
  type GasOracleConfigInput,
  type GasOverheadConfigInput,
  getInitIgpAccountInstruction,
  getInitOverheadIgpAccountInstruction,
  getSetDestinationGasOverheadsIx,
  getSetGasOracleConfigsIx,
} from './hook-tx.js';

/**
 * Extended IGP config for SVM that includes context for salt derivation.
 */
export interface SvmIgpHookConfig extends IgpHookConfig {
  /**
   * Context string used to derive salt via keccak256.
   * Salt = keccak256(context)
   */
  context?: string;
}

/**
 * Derives salt from context string using keccak256.
 * Matches Rust CLI behavior.
 */
export function deriveIgpSalt(context: string): Uint8Array {
  const hash = keccak256(Buffer.from(context, 'utf-8'));
  // keccak256 returns 0x-prefixed hex string, convert to bytes
  return new Uint8Array(Buffer.from(hash.slice(2), 'hex'));
}

/**
 * Default context for IGP salt derivation.
 */
export const DEFAULT_IGP_CONTEXT = 'hyperlane_igp';

/**
 * Reader for SVM IGP Hook.
 *
 * On Solana, the IGP consists of:
 * - IGP account (gas oracles per domain)
 * - Overhead IGP account (gas overheads per domain)
 *
 * Both are derived from the same salt.
 */
export class SvmIgpHookReader
  implements ArtifactReader<IgpHookConfig, DeployedHookAddress>
{
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

    // Convert gas oracles to config format
    const oracleConfig: Record<
      number,
      { gasPrice: string; tokenExchangeRate: string; tokenDecimals?: number }
    > = {};

    for (const [domain, oracle] of igp.gasOracles.entries()) {
      oracleConfig[domain] = remoteGasDataToConfig(oracle);
    }

    // Convert overheads to config format
    const overhead: Record<number, number> = {};
    if (overheadIgp) {
      for (const [domain, gas] of overheadIgp.gasOverheads.entries()) {
        overhead[domain] = Number(gas);
      }
    }

    // Determine owner and beneficiary
    const owner =
      igp.owner?.__option === 'Some' ? (igp.owner.value as string) : '';
    const beneficiary = igp.beneficiary as string;

    // Derive the IGP PDA address for the deployed address
    const [igpPda] = await getIgpAccountPda(this.programId, this.salt);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: HookType.INTERCHAIN_GAS_PAYMASTER as 'interchainGasPaymaster',
        owner,
        beneficiary,
        oracleKey: owner, // oracleKey is typically same as owner
        overhead,
        oracleConfig,
      },
      deployed: {
        address: igpPda,
      },
    };
  }
}

/**
 * Writer for SVM IGP Hook.
 *
 * Handles:
 * 1. Init IGP account
 * 2. Init Overhead IGP account
 * 3. Set gas oracles per domain
 * 4. Set gas overheads per domain
 */
export class SvmIgpHookWriter
  extends SvmIgpHookReader
  implements ArtifactWriter<IgpHookConfig, DeployedHookAddress>
{
  constructor(
    rpc: Rpc<SolanaRpcApi>,
    programId: Address,
    salt: Uint8Array,
    private readonly signer: SvmSigner,
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

    // Check if IGP account exists
    let igp = await fetchIgpAccount(this.rpc, this.programId, this.salt);

    if (!igp) {
      // Initialize IGP account
      const initIgpIx = await getInitIgpAccountInstruction({
        payer: this.signer.keypair,
        programId: this.programId,
        salt: this.salt,
        owner: config.owner ? (config.owner as Address) : null,
        beneficiary: config.beneficiary as Address,
      });

      const initReceipt = await this.signer.signAndSend(this.rpc, {
        instructions: [initIgpIx],
      });
      receipts.push(initReceipt);

      // Refetch after init
      igp = await fetchIgpAccount(this.rpc, this.programId, this.salt);
    }

    // Get IGP PDA address
    const [igpPda] = await getIgpAccountPda(this.programId, this.salt);

    // Check if Overhead IGP account exists
    const overheadIgp = await fetchOverheadIgpAccount(
      this.rpc,
      this.programId,
      this.salt,
    );

    if (!overheadIgp && Object.keys(config.overhead).length > 0) {
      // Initialize Overhead IGP account
      const initOverheadIx = await getInitOverheadIgpAccountInstruction({
        payer: this.signer.keypair,
        programId: this.programId,
        salt: this.salt,
        owner: config.owner ? (config.owner as Address) : null,
        innerIgp: igpPda,
      });

      const initOverheadReceipt = await this.signer.signAndSend(this.rpc, {
        instructions: [initOverheadIx],
      });
      receipts.push(initOverheadReceipt);
    }

    // Set gas oracle configs
    const oracleConfigs: GasOracleConfigInput[] = Object.entries(
      config.oracleConfig,
    ).map(([domainStr, oracleData]) => ({
      domain: parseInt(domainStr),
      gasPrice: BigInt(oracleData.gasPrice),
      tokenExchangeRate: BigInt(oracleData.tokenExchangeRate),
      tokenDecimals: oracleData.tokenDecimals ?? 9, // Default to 9 for SOL
    }));

    if (oracleConfigs.length > 0) {
      const setOracleIx = await getSetGasOracleConfigsIx({
        owner: this.signer.keypair,
        programId: this.programId,
        igpAccount: igpPda,
        configs: oracleConfigs,
      });

      const oracleReceipt = await this.signer.signAndSend(this.rpc, {
        instructions: [setOracleIx],
      });
      receipts.push(oracleReceipt);
    }

    // Set gas overheads
    const overheadConfigs: GasOverheadConfigInput[] = Object.entries(
      config.overhead,
    ).map(([domainStr, gas]) => ({
      destinationDomain: parseInt(domainStr),
      gasOverhead: BigInt(gas),
    }));

    if (overheadConfigs.length > 0) {
      const [overheadIgpPda] = await getOverheadIgpAccountPda(
        this.programId,
        this.salt,
      );

      const setOverheadIx = await getSetDestinationGasOverheadsIx({
        owner: this.signer.keypair,
        programId: this.programId,
        overheadIgpAccount: overheadIgpPda,
        configs: overheadConfigs,
      });

      const overheadReceipt = await this.signer.signAndSend(this.rpc, {
        instructions: [setOverheadIx],
      });
      receipts.push(overheadReceipt);
    }

    const deployedArtifact: ArtifactDeployed<
      IgpHookConfig,
      DeployedHookAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: config,
      deployed: {
        address: igpPda,
      },
    };

    return [deployedArtifact, receipts];
  }

  async update(
    artifact: ArtifactDeployed<IgpHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const txs: AnnotatedSvmTransaction[] = [];
    const config = artifact.config;

    // Read current state
    const currentIgp = await fetchIgpAccount(
      this.rpc,
      this.programId,
      this.salt,
    );
    if (!currentIgp) {
      throw new Error('IGP account not initialized');
    }

    // Compare oracle configs and generate update txs
    const [igpPda] = await getIgpAccountPda(this.programId, this.salt);

    const oracleConfigsToUpdate: GasOracleConfigInput[] = [];
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
        const existing = existingOracle.fields[0];
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
          gasPrice: newGasPrice,
          tokenExchangeRate: newTokenExchangeRate,
          tokenDecimals: newTokenDecimals,
        });
      }
    }

    if (oracleConfigsToUpdate.length > 0) {
      const setOracleIx = await getSetGasOracleConfigsIx({
        owner: this.signer.keypair,
        programId: this.programId,
        igpAccount: igpPda,
        configs: oracleConfigsToUpdate,
      });

      txs.push({
        instructions: [setOracleIx],
        annotation: `Update gas oracles for ${oracleConfigsToUpdate.length} domains`,
      });
    }

    // Compare overhead configs
    const currentOverheadIgp = await fetchOverheadIgpAccount(
      this.rpc,
      this.programId,
      this.salt,
    );

    const overheadConfigsToUpdate: GasOverheadConfigInput[] = [];
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
      const [overheadIgpPda] = await getOverheadIgpAccountPda(
        this.programId,
        this.salt,
      );

      const setOverheadIx = await getSetDestinationGasOverheadsIx({
        owner: this.signer.keypair,
        programId: this.programId,
        overheadIgpAccount: overheadIgpPda,
        configs: overheadConfigsToUpdate,
      });

      txs.push({
        instructions: [setOverheadIx],
        annotation: `Update gas overheads for ${overheadConfigsToUpdate.length} domains`,
      });
    }

    return txs;
  }
}
