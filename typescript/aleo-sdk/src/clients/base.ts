import type {
  AleoNetworkClient as AleoMainnetNetworkClient,
  ProgramManager as MainnetProgramManager,
} from '@provablehq/sdk/mainnet.js';
import type {
  AleoNetworkClient as AleoTestnetNetworkClient,
  ProgramManager as TestnetProgramManager,
} from '@provablehq/sdk/testnet.js';

import { assert, retryAsync } from '@hyperlane-xyz/utils';

import {
  getNetworkPrefix,
  RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
} from '../utils/helper.js';
import type { AleoSdk } from '../utils/provable.js';
import { AleoNetworkId, toAleoNetworkId } from '../utils/types.js';

export type AnyAleoNetworkClient =
  | AleoMainnetNetworkClient
  | AleoTestnetNetworkClient;

export type AnyProgramManager = MainnetProgramManager | TestnetProgramManager;

export class AleoBase {
  protected readonly rpcUrls: string[];
  protected readonly chainId: number;
  protected readonly sdk: AleoSdk;

  protected readonly prefix: string;

  protected readonly aleoClient: AnyAleoNetworkClient;
  protected readonly skipProofs: boolean;
  protected readonly skipSuffixes: boolean;
  protected readonly consensusVersionHeights: string;
  protected readonly ismManager: string;
  protected readonly warpSuffix: string;

  constructor(rpcUrls: string[], chainId: string | number, sdk: AleoSdk) {
    const aleoNetworkId = toAleoNetworkId(+chainId);
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    // because the aleo provable sdk appends /testnet or /mainnet to the base
    // rpc automatically we need to remove it here
    this.rpcUrls = rpcUrls.map((r) =>
      r.replaceAll('/testnet', '').replaceAll('/mainnet', ''),
    );
    this.chainId = aleoNetworkId;
    this.sdk = sdk;

    this.aleoClient = new this.sdk.AleoNetworkClient(this.rpcUrls[0]);

    this.skipProofs = JSON.parse(process.env['ALEO_SKIP_PROOFS'] || 'false');
    this.skipSuffixes = JSON.parse(
      process.env['ALEO_SKIP_SUFFIXES'] || 'false',
    );
    this.consensusVersionHeights =
      process.env['ALEO_CONSENSUS_VERSION_HEIGHTS'] || '';

    if (this.consensusVersionHeights) {
      this.sdk.getOrInitConsensusVersionTestHeights(
        this.consensusVersionHeights,
      );
    }

    this.prefix = getNetworkPrefix(aleoNetworkId);

    this.ismManager = process.env['ALEO_ISM_MANAGER_SUFFIX']
      ? `${this.prefix}_ism_manager_${process.env['ALEO_ISM_MANAGER_SUFFIX']}.aleo`
      : `${this.prefix}_ism_manager.aleo`;

    this.warpSuffix = process.env['ALEO_WARP_SUFFIX'] || '';
  }

  getAleoClient(): AnyAleoNetworkClient {
    return this.aleoClient;
  }

  protected getProgramManager(privateKey?: string): AnyProgramManager {
    const account = privateKey
      ? new this.sdk.Account({ privateKey })
      : new this.sdk.Account();

    const keyProvider = new this.sdk.AleoKeyProvider();
    keyProvider.useCache(true);

    const networkRecordProvider = new this.sdk.NetworkRecordProvider(
      account,
      new this.sdk.AleoNetworkClient(this.rpcUrls[0]),
    );

    const programManager = new this.sdk.ProgramManager(
      this.rpcUrls[0],
      keyProvider,
      networkRecordProvider,
    );
    programManager.setAccount(account);

    return programManager;
  }

  private get networkPath(): string {
    return this.chainId === AleoNetworkId.TESTNET ? 'testnet' : 'mainnet';
  }

  protected async findBlockHashByTxId(txId: string): Promise<string> {
    const url = `${this.rpcUrls[0]}/${this.networkPath}/find/blockHash/${txId}`;
    return retryAsync(
      async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return JSON.parse(await res.text()) as string;
      },
      RETRY_ATTEMPTS,
      RETRY_DELAY_MS,
    );
  }

  protected async queryMappingValue(
    programId: string,
    mappingName: string,
    key: string,
    { retryOnNull = false }: { retryOnNull?: boolean } = {},
  ): Promise<any | undefined> {
    try {
      const result = await retryAsync(
        async () => {
          const r = await this.aleoClient.getProgramMappingValue(
            programId,
            mappingName,
            key,
          );
          // Freshly-finalized state can briefly lag behind the
          // confirmed-transaction endpoint, so give callers that just
          // confirmed a tx the option to retry until the mapping catches up.
          if (r === null && retryOnNull) {
            throw new Error(
              `mapping value for ${programId}/${mappingName}/${key} not yet indexed`,
            );
          }
          return r;
        },
        RETRY_ATTEMPTS,
        RETRY_DELAY_MS,
      );

      if (result === null) {
        return;
      }

      return this.sdk.Plaintext.fromString(result).toObject();
    } catch (err) {
      throw new Error(
        `Failed to query mapping value for program ${programId}/${mappingName}/${key}: ${err}`,
      );
    }
  }

  protected async queryMappingString(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<string> {
    try {
      const result = await retryAsync(
        async () => {
          const r = await this.aleoClient.getProgramMappingValue(
            programId,
            mappingName,
            key,
          );

          if (r === null) {
            throw new Error(`mapping value is null`);
          }

          return r;
        },
        RETRY_ATTEMPTS,
        RETRY_DELAY_MS,
      );

      return result;
    } catch (err) {
      throw new Error(
        `Failed to query mapping value for program ${programId}/${mappingName}/${key}: ${err}`,
      );
    }
  }
}
