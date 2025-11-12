import {
  AleoKeyProvider as AleoMainnetKeyProvider,
  AleoNetworkClient as AleoMainnetNetworkClient,
  Account as MainnetAccount,
  BHP256 as MainnetBHP256,
  NetworkRecordProvider as MainnetNetworkRecordProvider,
  Plaintext as MainnetPlaintext,
  Program as MainnetProgram,
  ProgramManager as MainnetProgramManager,
  U128 as MainnetU128,
} from '@provablehq/sdk/mainnet.js';
import { initThreadPool } from '@provablehq/sdk/mainnet.js';
import {
  AleoKeyProvider as AleoTestnetKeyProvider,
  AleoNetworkClient as AleoTestnetNetworkClient,
  Account as TestnetAccount,
  BHP256 as TestnetBHP256,
  NetworkRecordProvider as TestnetNetworkRecordProvider,
  Plaintext as TestnetPlaintext,
  Program as TestnetProgram,
  ProgramManager as TestnetProgramManager,
  U128 as TestnetU128,
  getOrInitConsensusVersionTestHeights,
} from '@provablehq/sdk/testnet.js';

import { assert } from '@hyperlane-xyz/utils';

import { mailbox } from '../artifacts.js';

export type AnyAleoNetworkClient =
  | AleoMainnetNetworkClient
  | AleoTestnetNetworkClient;

export type AnyProgramManager = MainnetProgramManager | TestnetProgramManager;

await initThreadPool();

export class AleoBase {
  protected readonly rpcUrls: string[];
  protected readonly chainId: number;

  protected readonly aleoClient: AnyAleoNetworkClient;

  constructor(rpcUrls: string[], chainId: string | number) {
    assert(
      +chainId === 0 || +chainId === 1,
      `Unknown chain id ${chainId} for Aleo, only 0 or 1 allowed`,
    );
    assert(rpcUrls.length > 0, `got no rpcUrls`);

    getOrInitConsensusVersionTestHeights('0,1,2,3,4,5,6,7,8,9,10');

    this.rpcUrls = rpcUrls;
    this.chainId = +chainId;

    this.aleoClient = this.chainId
      ? new AleoTestnetNetworkClient(rpcUrls[0])
      : new AleoMainnetNetworkClient(rpcUrls[0]);
  }

  protected get Program() {
    return this.chainId ? TestnetProgram : MainnetProgram;
  }

  protected get Plaintext() {
    return this.chainId ? TestnetPlaintext : MainnetPlaintext;
  }

  protected get U128() {
    return this.chainId ? TestnetU128 : MainnetU128;
  }

  protected get BHP256() {
    return this.chainId ? TestnetBHP256 : MainnetBHP256;
  }

  protected getProgramManager(privateKey?: string): AnyProgramManager {
    if (this.chainId) {
      const account = privateKey
        ? new TestnetAccount({ privateKey })
        : new TestnetAccount();

      const keyProvider = new AleoTestnetKeyProvider();
      keyProvider.useCache(true);

      const networkRecordProvider = new TestnetNetworkRecordProvider(
        new TestnetAccount({ privateKey }),
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
      new MainnetAccount({ privateKey }),
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

  protected getAddressFromProgramId(programId: string): string {
    const program = this.chainId ? TestnetProgram : MainnetProgram;

    // TODO: calculate address directly with poseidon hash
    return program
      .fromString(mailbox.replaceAll('mailbox.aleo', programId))
      .address()
      .to_string();
  }
}
