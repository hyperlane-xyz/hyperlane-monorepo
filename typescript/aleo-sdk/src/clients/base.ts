import {
  AleoKeyProvider as AleoMainnetKeyProvider,
  AleoNetworkClient as AleoMainnetNetworkClient,
  Account as MainnetAccount,
  NetworkRecordProvider as MainnetNetworkRecordProvider,
  ProgramManager as MainnetProgramManager,
  Plaintext,
} from '@provablehq/sdk/mainnet.js';
import {
  AleoKeyProvider as AleoTestnetKeyProvider,
  AleoNetworkClient as AleoTestnetNetworkClient,
  Account as TestnetAccount,
  NetworkRecordProvider as TestnetNetworkRecordProvider,
  ProgramManager as TestnetProgramManager,
  getOrInitConsensusVersionTestHeights,
} from '@provablehq/sdk/testnet.js';

import { assert } from '@hyperlane-xyz/utils';

import { MAINNET_PREFIX, TESTNET_PREFIX } from '../utils/helper.js';

export type AnyAleoNetworkClient =
  | AleoMainnetNetworkClient
  | AleoTestnetNetworkClient;

export type AnyProgramManager = MainnetProgramManager | TestnetProgramManager;

export class AleoBase {
  protected readonly rpcUrls: string[];
  protected readonly chainId: number;

  protected readonly prefix: string;

  protected readonly aleoClient: AnyAleoNetworkClient;
  protected readonly skipProofs: boolean;
  protected readonly skipSuffixes: boolean;
  protected readonly consensusVersionHeights: string;
  protected readonly ismManager: string;
  protected readonly warpSuffix: string;

  constructor(rpcUrls: string[], chainId: string | number) {
    assert(
      +chainId === 0 || +chainId === 1,
      `Unknown chain id ${chainId} for Aleo, only 0 or 1 allowed`,
    );
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    this.rpcUrls = rpcUrls.map((r) =>
      r.replaceAll('/testnet', '').replaceAll('/mainnet', ''),
    );
    this.chainId = +chainId;

    this.aleoClient = this.chainId
      ? new AleoTestnetNetworkClient(this.rpcUrls[0])
      : new AleoMainnetNetworkClient(this.rpcUrls[0]);

    this.skipProofs = JSON.parse(process.env['ALEO_SKIP_PROOFS'] || 'false');
    this.skipSuffixes = JSON.parse(
      process.env['ALEO_SKIP_SUFFIXES'] || 'false',
    );
    this.consensusVersionHeights =
      process.env['ALEO_CONSENSUS_VERSION_HEIGHTS'] || '';

    if (this.consensusVersionHeights) {
      getOrInitConsensusVersionTestHeights(this.consensusVersionHeights);
    }

    this.prefix = this.chainId ? TESTNET_PREFIX : MAINNET_PREFIX;

    this.ismManager = process.env['ALEO_ISM_MANAGER_SUFFIX']
      ? `${this.prefix}_ism_manager_${process.env['ALEO_ISM_MANAGER_SUFFIX']}.aleo`
      : `${this.prefix}_ism_manager.aleo`;

    this.warpSuffix = process.env['ALEO_WARP_SUFFIX'] || '';
  }

  protected getProgramManager(privateKey?: string): AnyProgramManager {
    if (this.chainId) {
      const account = privateKey
        ? new TestnetAccount({ privateKey })
        : new TestnetAccount();

      const keyProvider = new AleoTestnetKeyProvider();
      keyProvider.useCache(true);

      const networkRecordProvider = new TestnetNetworkRecordProvider(
        account,
        new AleoTestnetNetworkClient(this.rpcUrls[0]),
      );

      const programManager = new TestnetProgramManager(
        this.rpcUrls[0],
        keyProvider,
        networkRecordProvider,
      );
      programManager.setAccount(account);

      return programManager;
    }

    const account = privateKey
      ? new MainnetAccount({ privateKey })
      : new MainnetAccount();

    const keyProvider = new AleoMainnetKeyProvider();
    keyProvider.useCache(true);

    const networkRecordProvider = new MainnetNetworkRecordProvider(
      account,
      new AleoMainnetNetworkClient(this.rpcUrls[0]),
    );

    const programManager = new MainnetProgramManager(
      this.rpcUrls[0],
      keyProvider,
      networkRecordProvider,
    );
    programManager.setAccount(account);

    return programManager;
  }

  protected async queryMappingValue(
    programId: string,
    mappingName: string,
    key: string,
  ): Promise<any | undefined> {
    try {
      const result = await this.aleoClient.getProgramMappingValue(
        programId,
        mappingName,
        key,
      );

      if (result === null) {
        return;
      }

      return Plaintext.fromString(result).toObject();
    } catch (err) {
      throw new Error(
        `Failed to query mapping value for program ${programId}/${mappingName}/${key}: ${err}`,
      );
    }
  }
}
