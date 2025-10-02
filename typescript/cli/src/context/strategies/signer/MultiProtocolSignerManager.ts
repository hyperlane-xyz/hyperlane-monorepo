import { BigNumber, Signer } from 'ethers';
import { Logger } from 'pino';

import {
  ChainName,
  IMultiProtocolSignerManager,
  MultiProtocolProvider,
  MultiProvider,
  ProtocolMap,
  isJsonRpcSubmitterConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ExtendedChainSubmissionStrategy } from '../../../submitters/types.js';
import { SignerKeyProtocolMap } from '../../types.js';

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

/**
 * @title MultiProtocolSignerManager
 * @dev Context manager for signers across multiple protocols
 */
export class MultiProtocolSignerManager implements IMultiProtocolSignerManager {
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
      multiProvider.setSigner(chain, this.getEVMSigner(chain));
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

    return maybeSigner as T;
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
}
