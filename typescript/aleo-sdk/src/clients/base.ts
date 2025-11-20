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
} from '@provablehq/sdk/testnet.js';

import { assert, strip0x } from '@hyperlane-xyz/utils';

import { credits } from '../artifacts.js';

export type AnyAleoNetworkClient =
  | AleoMainnetNetworkClient
  | AleoTestnetNetworkClient;

export type AnyProgramManager = MainnetProgramManager | TestnetProgramManager;

export class AleoBase {
  protected readonly rpcUrls: string[];
  protected readonly chainId: number;

  protected readonly aleoClient: AnyAleoNetworkClient;
  protected readonly skipProof: boolean;

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

    this.skipProof = process.env['ALEO_SKIP_PROOF']
      ? JSON.parse(process.env['ALEO_SKIP_PROOF'])
      : false;
  }

  protected get Plaintext() {
    return this.chainId ? TestnetPlaintext : MainnetPlaintext;
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

  protected async queryMappingValue(
    programId: string,
    mappingName: string,
    key: string,
    fallbackValue?: any,
  ): Promise<any> {
    try {
      const result = await this.aleoClient.getProgramMappingValue(
        programId,
        mappingName,
        key,
      );

      if (result === null) {
        if (fallbackValue !== undefined) {
          return fallbackValue;
        }

        throw new Error(
          `Value for key ${key} on mapping ${mappingName} is empty`,
        );
      }

      const Plaintext = this.chainId ? TestnetPlaintext : MainnetPlaintext;
      return Plaintext.fromString(result).toObject();
    } catch (err) {
      throw new Error(
        `Failed to query mapping value for program ${programId}/${mappingName}/${key}: ${err}`,
      );
    }
  }

  protected getAddressFromProgramId(programId: string): string {
    const program = this.chainId ? TestnetProgram : MainnetProgram;

    return program
      .fromString(credits.replaceAll('credits.aleo', programId))
      .address()
      .to_string();
  }

  protected stringToU128String(input: string): string {
    if (input.length > 16) {
      throw new Error(`string "${input}" is too long to convert it into U128`);
    }

    const encoded = new TextEncoder().encode(input);
    const bytes = new Uint8Array(16);
    bytes.set(encoded.subarray(0, 16));

    const U128 = this.chainId ? TestnetU128 : MainnetU128;
    return U128.fromBytesLe(bytes).toString();
  }

  protected U128StringToString(input: string): string {
    const U128 = this.chainId ? TestnetU128 : MainnetU128;
    return new TextDecoder().decode(
      U128.fromString(input)
        .toBytesLe()
        .filter((b) => b > 0),
    );
  }

  protected bytes32ToU128String(input: string): string {
    const bytes = Buffer.from(strip0x(input), 'hex');

    // Split into two 128-bit chunks
    const lowBytes = Uint8Array.from(bytes.subarray(0, 16));
    const highBytes = Uint8Array.from(bytes.subarray(16, 32));

    const U128 = this.chainId ? TestnetU128 : MainnetU128;
    return `[${U128.fromBytesLe(lowBytes).toString()},${U128.fromBytesLe(highBytes).toString()}]`;
  }

  protected getBalanceKey(address: string, denom: string): string {
    const BHP256 = this.chainId ? TestnetBHP256 : MainnetBHP256;

    return new BHP256()
      .hash(
        this.Plaintext.fromString(
          `{account:${address},token_id:${denom}}`,
        ).toBitsLe(),
      )
      .toString();
  }
}
