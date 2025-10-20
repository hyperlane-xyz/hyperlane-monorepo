import { BigNumber, Signer } from 'ethers';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  ChainName,
  IMultiProtocolSignerManager,
  MultiProtocolProvider,
  MultiProvider,
  ProtocolMap,
<<<<<<< HEAD
  getLocalProvider,
=======
  isJsonRpcSubmitterConfig,
>>>>>>> main
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ExtendedChainSubmissionStrategy } from '../../../submitters/types.js';
<<<<<<< HEAD
=======
import { SignerKeyProtocolMap } from '../../types.js';
>>>>>>> main

import {
  IMultiProtocolSigner,
  SignerConfig,
  TypedSigner,
} from './BaseMultiProtocolSigner.js';
import { MultiProtocolSignerFactory } from './MultiProtocolSignerFactory.js';

export interface MultiProtocolSignerOptions {
  logger?: Logger;
  key?: SignerKeyProtocolMap;
}

function getSignerCompatibleChains(
  multiProtocolProvider: MultiProtocolProvider,
  chains: ChainName[],
): ReadonlyArray<ChainName> {
  return chains.filter(
    (chain) =>
      multiProtocolProvider.getProtocol(chain) === ProtocolType.Ethereum,
  );
}

function getProtocolsFromChains(
  multiProtocolProvider: MultiProtocolProvider,
  chains: ReadonlyArray<ChainName>,
): ReadonlyArray<ProtocolType> {
  const protocols = chains.map((chain) =>
    multiProtocolProvider.getProtocol(chain),
  );

  return Array.from(new Set(protocols));
}

const envScheme = z.object({
  HYP_KEY: z.string().optional(),
  ANVIL_IP_ADDR: z.string().optional(),
  ANVIL_PORT: z.number().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),
  GH_AUTH_TOKEN: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
});

const parsedEnv = envScheme.safeParse(process.env);

export const ENV = parsedEnv.success ? parsedEnv.data : {};

/**
 * @title MultiProtocolSignerManager
 * @dev Context manager for signers across multiple protocols
 */
export class MultiProtocolSignerManager implements IMultiProtocolSignerManager {
<<<<<<< HEAD
  protected readonly signerStrategies: Map<ChainName, IMultiProtocolSigner>;
=======
>>>>>>> main
  protected readonly signers: Map<ChainName, TypedSigner>;
  public readonly logger: Logger;

  protected constructor(
    protected readonly submissionStrategy: Partial<ExtendedChainSubmissionStrategy>,
    protected readonly chains: ReadonlyArray<ChainName>,
    protected readonly signerStrategiesByProtocol: Partial<
      ProtocolMap<IMultiProtocolSigner>
    >,
    protected readonly multiProtocolProvider: MultiProtocolProvider,
    protected readonly options: MultiProtocolSignerOptions = {},
  ) {
    this.logger =
      options?.logger ||
      rootLogger.child({
        module: MultiProtocolSignerManager.name,
      });
    this.signers = new Map();
  }

  /**
   * Creates an instance of {@link MultiProtocolSignerManager} with all the signers
   * initialized for the provided supported chains
   */
  static async init(
    submissionStrategy: Partial<ExtendedChainSubmissionStrategy>,
    chains: ChainName[],
    multiProtocolProvider: MultiProtocolProvider,
    options: MultiProtocolSignerOptions = {},
  ): Promise<MultiProtocolSignerManager> {
    const supportedChains = getSignerCompatibleChains(
      multiProtocolProvider,
      chains,
    );
    const supportedProtocols = getProtocolsFromChains(
      multiProtocolProvider,
      supportedChains,
    );

    const strategiesByProtocol: Partial<ProtocolMap<IMultiProtocolSigner>> =
      Object.fromEntries(
        supportedProtocols.map((protocol) => [
          protocol,
          MultiProtocolSignerFactory.getSignerStrategy(
            protocol,
            multiProtocolProvider,
          ),
        ]),
      );

    const instance = new MultiProtocolSignerManager(
      submissionStrategy,
      supportedChains,
      strategiesByProtocol,
      multiProtocolProvider,
      options,
    );

    await instance.initAllSigners();

    return instance;
  }

  /**
   * @dev Configures signers for EVM chains in MultiProvider
   */
  async getMultiProvider(): Promise<MultiProvider> {
    const multiProvider = this.multiProtocolProvider.toMultiProvider();

    const evmChains = this.chains.filter(
      (chain) =>
        this.multiProtocolProvider.getProtocol(chain) === ProtocolType.Ethereum,
    );

    for (const chain of evmChains) {
<<<<<<< HEAD
      this.multiProvider.setSigner(chain, this.signers.get(chain) as Signer);
=======
      multiProvider.setSigner(chain, this.getEVMSigner(chain));
>>>>>>> main
    }

    return multiProvider;
  }

  /**
   * @notice Creates signer for specific chain
   */
  async initSigner(chain: ChainName): Promise<TypedSigner> {
    const maybeSigner = this.signers.get(chain);
    if (maybeSigner) {
      return maybeSigner;
    }

    const protocolType = this.multiProtocolProvider.getProtocol(chain);

    const signerStrategy = this.signerStrategiesByProtocol[protocolType];
    assert(signerStrategy, `No signer strategy found for chain ${chain}`);

    const rawConfig = this.submissionStrategy[chain]?.submitter;

    let signerConfig: SignerConfig;
    const defaultPrivateKey = (this.options.key ?? {})[protocolType];
    if (isJsonRpcSubmitterConfig(rawConfig)) {
      signerConfig = rawConfig;

      // Even if the config is a json rpc one,
      // the private key might be undefined
      signerConfig.privateKey ??= defaultPrivateKey;
    } else {
      signerConfig = {
        chain,
        privateKey: defaultPrivateKey,
      };
    }

    const signer = await signerStrategy.getSigner(signerConfig);

    this.signers.set(chain, signer);
    return signer;
  }

  /**
   * @notice Creates signers for all chains
   */
  protected async initAllSigners(): Promise<typeof this.signers> {
    for (const chain of this.chains) {
      await this.initSigner(chain);
    }

    return this.signers;
  }

  getSpecificSigner<T>(chain: ChainName): T {
    const maybeSigner = this.signers.get(chain);
    assert(maybeSigner, `Signer not set for chain ${chain}`);

<<<<<<< HEAD
    let config = await this.extractPrivateKey(chain);

    // For Cosmos, we get additional params
    if (protocol === ProtocolType.CosmosNative) {
      const provider =
        await this.multiProtocolProvider.getCosmJsNativeProvider(chain);
      const { bech32Prefix, gasPrice } =
        this.multiProvider.getChainMetadata(chain);

      config = {
        ...config,
        extraParams: { provider, prefix: bech32Prefix, gasPrice },
      };
    }

    return { chain, ...config };
  }

  /**
   * @notice Gets private key from strategy
   */
  private async extractPrivateKey(chain: ChainName): Promise<SignerConfig> {
    const protocol = this.multiProvider.getProtocol(chain);

    if (
      protocol === ProtocolType.Ethereum &&
      typeof this.options.key === 'string'
    ) {
      this.logger.debug(
        `Using private key passed via CLI --key flag for chain ${chain}`,
      );
      return { privateKey: this.options.key };
    }

    if (typeof this.options.key === 'object') {
      assert(
        this.options.key[protocol],
        `Key flag --key.${protocol} for chain ${chain} not provided`,
      );
      this.logger.debug(
        `Using private key passed via CLI --key.${protocol} flag for chain ${chain}`,
      );
      return { privateKey: this.options.key[protocol] };
    }

    if (process.env[`HYP_KEY_${protocol.toUpperCase()}`]) {
      this.logger.debug(`Using private key from .env for chain ${chain}`);
      return { privateKey: process.env[`HYP_KEY_${protocol.toUpperCase()}`]! };
    }

    if (protocol === ProtocolType.Ethereum) {
      if (ENV.HYP_KEY) {
        this.logger.debug(`Using private key from .env for chain ${chain}`);
        return { privateKey: ENV.HYP_KEY };
      }
    }

    const signerStrategy = this.getSignerStrategyOrFail(chain);
    const strategyConfig = await signerStrategy.getSignerConfig(chain);
    assert(
      strategyConfig.privateKey,
      `No private key found for chain ${chain}`,
    );
    this.logger.debug(
      `Extracting private key from strategy config/user prompt for chain ${chain}`,
    );

    return { privateKey: strategyConfig.privateKey };
  }

  private getSignerStrategyOrFail(chain: ChainName): IMultiProtocolSigner {
    const strategy = this.signerStrategies.get(chain);
    assert(strategy, `No signer strategy found for chain ${chain}`);
    return strategy;
  }

  getSpecificSigner<T>(chain: ChainName): T {
    return this.signers.get(chain) as T;
=======
    return maybeSigner as T;
>>>>>>> main
  }

  getEVMSigner(chain: ChainName): Signer {
    const protocolType = this.multiProtocolProvider.getProtocol(chain);
    assert(
      protocolType === ProtocolType.Ethereum,
      `Chain ${chain} is not an Ethereum chain`,
    );
    return this.getSpecificSigner<Signer>(chain);
  }

  async getSignerAddress(chain: ChainName): Promise<Address> {
    const metadata = this.multiProtocolProvider.getChainMetadata(chain);

    switch (metadata.protocol) {
      case ProtocolType.Ethereum: {
        const signer = this.getEVMSigner(chain);
        return signer.getAddress();
      }
      default: {
        throw new Error(
          `Signer for protocol type ${metadata.protocol} not supported`,
        );
      }
    }
  }

  async getBalance(params: {
    address: Address;
    chain: ChainName;
    denom?: string;
  }): Promise<BigNumber> {
    const metadata = this.multiProtocolProvider.getChainMetadata(params.chain);

    switch (metadata.protocol) {
      case ProtocolType.Ethereum: {
        try {
          const provider = this.multiProtocolProvider.getEthersV5Provider(
            params.chain,
          );
          const balance = await provider.getBalance(params.address);
          return balance;
        } catch (err) {
          throw new Error(
            `failed to get balance of address ${params.address} on EVM chain ${params.chain}: ${err}`,
          );
        }
      }
      default: {
        throw new Error(
          `Retrieving balance for account of protocol type ${metadata.protocol} not supported chain ${params.chain}`,
        );
      }
    }
  }

  async getSignerAddress(chain: ChainName): Promise<Address> {
    const metadata = this.multiProvider.getChainMetadata(chain);

    switch (metadata.protocol) {
      case ProtocolType.Ethereum: {
        const signer = this.getEVMSigner(chain);
        return signer.getAddress();
      }
      case ProtocolType.CosmosNative: {
        const signer = this.getCosmosNativeSigner(chain);
        return signer.account.address;
      }
      default: {
        throw new Error(
          `Signer for protocol type ${metadata.protocol} not supported`,
        );
      }
    }
  }

  async getBalance(params: {
    isDryRun: boolean;
    address: Address;
    chain: ChainName;
    denom?: string;
  }): Promise<BigNumber> {
    const metadata = this.multiProvider.getChainMetadata(params.chain);

    switch (metadata.protocol) {
      case ProtocolType.Ethereum: {
        try {
          const provider = params.isDryRun
            ? getLocalProvider({
                anvilIPAddr: ENV.ANVIL_IP_ADDR,
                anvilPort: ENV.ANVIL_PORT,
              })
            : this.multiProvider.getProvider(params.chain);
          const balance = await provider.getBalance(params.address);
          return balance;
        } catch (err) {
          throw new Error(
            `failed to get balance of address ${params.address} on EVM chain ${params.chain}: ${err}`,
          );
        }
      }
      case ProtocolType.CosmosNative: {
        assert(
          params.denom,
          `need denom to get balance of Cosmos Native chain ${params.chain}`,
        );

        try {
          const provider =
            await this.multiProtocolProvider.getCosmJsNativeProvider(
              params.chain,
            );
          const balance = await provider.getBalance(
            params.address,
            params.denom,
          );
          return BigNumber.from(balance.amount);
        } catch (err) {
          throw new Error(
            `failed to get balance of address ${params.address} on Cosmos Native chain ${params.chain}: ${err}`,
          );
        }
      }
      default: {
        throw new Error(
          `Retrieving balance for account of protocol type ${metadata.protocol} not supported chain ${params.chain}`,
        );
      }
    }
  }
}
