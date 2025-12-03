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

export type AnyAleoNetworkClient =
  | AleoMainnetNetworkClient
  | AleoTestnetNetworkClient;

export type AnyProgramManager = MainnetProgramManager | TestnetProgramManager;

export class AleoBase {
  protected readonly rpcUrls: string[];
  protected readonly chainId: number;

  protected readonly aleoClient: AnyAleoNetworkClient;
  protected readonly skipProofs: boolean;
  protected readonly skipSuffixes: boolean;
  protected readonly consensusVersionHeights: string;
  protected readonly ismManager: string;

  constructor(rpcUrls: string[], chainId: string | number) {
    assert(
      +chainId === 0 || +chainId === 1,
      `Unknown chain id ${chainId} for Aleo, only 0 or 1 allowed`,
    );
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    this.rpcUrls = rpcUrls;
    this.chainId = +chainId;

    this.aleoClient = this.chainId
      ? new AleoTestnetNetworkClient(rpcUrls[0])
      : new AleoMainnetNetworkClient(rpcUrls[0]);

    this.skipProofs = JSON.parse(process.env['ALEO_SKIP_PROOFS'] || 'false');
    this.skipSuffixes = JSON.parse(
      process.env['ALEO_SKIP_SUFFIXES'] || 'false',
    );
    this.consensusVersionHeights =
      process.env['ALEO_CONSENSUS_VERSION_HEIGHTS'] || '';

    if (this.consensusVersionHeights) {
      getOrInitConsensusVersionTestHeights(this.consensusVersionHeights);
    }

    this.ismManager = process.env['ALEO_ISM_MANAGER_SUFFIX']
      ? `ism_manager_${process.env['ALEO_ISM_MANAGER_SUFFIX']}.aleo`
      : 'ism_manager.aleo';
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
