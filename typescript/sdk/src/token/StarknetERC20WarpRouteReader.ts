import { Uint256, getChecksumAddress, num, uint256 } from 'starknet';

import { Address, Domain, rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { StarknetHookReader } from '../hook/StarknetHookReader.js';
import { StarknetIsmReader } from '../ism/StarknetIsmReader.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { StarknetJsProvider } from '../providers/ProviderType.js';
import {
  DestinationGas,
  MailboxClientConfig,
  RemoteRouters,
} from '../router/types.js';
import { ChainName } from '../types.js';
import {
  getStarknetHypERC20CollateralContract,
  getStarknetHypERC20Contract,
  getStarknetHypNativeContract,
} from '../utils/starknet.js';

import { TokenType } from './config.js';
import {
  HypTokenConfig,
  HypTokenRouterConfig,
  TokenMetadata,
} from './types.js';

export class StarknetERC20WarpRouteReader {
  protected readonly logger = rootLogger.child({
    module: 'StarknetERC20WarpRouteReader',
  });
  starknetHookReader: StarknetHookReader;
  starknetIsmReader: StarknetIsmReader;
  protected readonly domainId: Domain;
  protected readonly provider: StarknetJsProvider['provider'];

  private static tokenTypeCache: Map<string, TokenType> = new Map();

  constructor(
    protected readonly multiProvider: MultiProtocolProvider,
    protected readonly chain: ChainName,
    protected readonly concurrency: number = DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    this.provider = multiProvider.getStarknetProvider(chain);
    this.starknetHookReader = new StarknetHookReader(multiProvider, chain);
    this.starknetIsmReader = new StarknetIsmReader(multiProvider, chain);
    this.domainId = multiProvider.getDomainId(chain);
  }

  /**
   * Derives the configuration for a Hyperlane Starknet token router contract at the given address.
   *
   * @param warpRouteAddress - The address of the Hyperlane token router contract.
   * @returns The configuration for the Hyperlane token router.
   */
  async deriveWarpRouteConfig(
    warpRouteAddress: Address,
  ): Promise<HypTokenRouterConfig> {
    // Derive the token type
    const type = await this.deriveTokenType(warpRouteAddress);
    const baseMetadata = await this.fetchMailboxClientConfig(warpRouteAddress);
    const tokenConfig = await this.fetchTokenConfig(type, warpRouteAddress);
    const remoteRouters = await this.fetchRemoteRouters(warpRouteAddress);
    const destinationGas = await this.fetchDestinationGas(warpRouteAddress);

    return {
      ...baseMetadata,
      ...tokenConfig,
      remoteRouters,
      destinationGas,
      type,
    } as HypTokenRouterConfig;
  }

  /**
   * Determines the type of token contract at the given address.
   *
   * @param warpRouteAddress - The address of the token contract.
   * @returns The token type.
   */
  async deriveTokenType(warpRouteAddress: Address): Promise<TokenType> {
    const cacheKey = `${this.domainId}-${warpRouteAddress}`;
    const cached = StarknetERC20WarpRouteReader.tokenTypeCache.get(cacheKey);
    if (cached) return cached;

    this.logger.debug(
      `Deriving token type for ${warpRouteAddress} on ${this.chain}`,
    );

    try {
      // Try to detect if this is a collateral token
      try {
        const collateralContract = getStarknetHypERC20CollateralContract(
          warpRouteAddress,
          this.provider,
        );
        // Check if contract has wrapped_token function
        await collateralContract.wrapped_token();
        const type = TokenType.collateral;
        StarknetERC20WarpRouteReader.tokenTypeCache.set(cacheKey, type);
        return type;
      } catch (_e) {
        // Not a collateral token
      }

      // Try to detect if this is a native token
      try {
        const nativeContract = getStarknetHypNativeContract(
          warpRouteAddress,
          this.provider,
        );
        // Check if contract has native_token function
        await nativeContract.native_token();
        const type = TokenType.native;
        StarknetERC20WarpRouteReader.tokenTypeCache.set(cacheKey, type);
        return type;
      } catch (_e) {
        // Not a native token
      }

      // Default to synthetic token if previous checks fail
      const type = TokenType.synthetic;
      StarknetERC20WarpRouteReader.tokenTypeCache.set(cacheKey, type);
      return type;
    } catch (e) {
      this.logger.error(
        `Failed to derive token type for ${warpRouteAddress}`,
        e,
      );
      throw new Error(`Unable to determine token type: ${e}`);
    }
  }

  /**
   * Fetches the base metadata for a token contract.
   *
   * @param routerAddress - The address of the token contract.
   * @returns The base metadata for the token contract.
   */
  async fetchMailboxClientConfig(
    routerAddress: Address,
  ): Promise<MailboxClientConfig> {
    const contract = getStarknetHypERC20Contract(routerAddress, this.provider);

    const [mailbox, owner, hook, ism] = await Promise.all([
      contract.mailbox().then((res: any) => num.toHex64(res.toString())),
      contract.owner().then((res: any) => num.toHex64(res.toString())),
      contract.get_hook().then((res: any) => num.toHex64(res.toString())),
      contract
        .interchain_security_module()
        .then((res: any) => num.toHex64(res.toString())),
    ]);

    const derivedIsm =
      ism === getChecksumAddress(0)
        ? getChecksumAddress(0)
        : await this.starknetIsmReader.deriveIsmConfig(ism);

    const derivedHook =
      hook === getChecksumAddress(0)
        ? getChecksumAddress(0)
        : await this.starknetHookReader.deriveHookConfig(hook);

    return {
      mailbox,
      owner,
      hook: derivedHook,
      interchainSecurityModule: derivedIsm,
    };
  }

  /**
   * Fetches token-specific configuration based on token type.
   *
   * @param type - The token type.
   * @param warpRouteAddress - The address of the token contract.
   * @returns Token-specific configuration.
   */
  async fetchTokenConfig(
    type: TokenType,
    warpRouteAddress: Address,
  ): Promise<HypTokenConfig> {
    if (type === TokenType.collateral) {
      const contract = getStarknetHypERC20CollateralContract(
        warpRouteAddress,
        this.provider,
      );

      const token = await contract
        .wrapped_token()
        .then((res: any) => num.toHex64(res.toString()));

      const { name, symbol, decimals } = await this.fetchERC20Metadata(token);

      return {
        type,
        name,
        symbol,
        decimals,
        token,
      };
    } else if (type === TokenType.synthetic) {
      const metadata = await this.fetchERC20Metadata(warpRouteAddress);
      return {
        type,
        ...metadata,
      };
    } else if (type === TokenType.native) {
      const chainMetadata = this.multiProvider.getChainMetadata(this.chain);
      if (chainMetadata.nativeToken) {
        const { name, symbol, decimals } = chainMetadata.nativeToken;
        return {
          type,
          name,
          symbol,
          decimals,
        };
      } else {
        throw new Error(
          `Chain metadata for ${this.chain} does not provide native token details`,
        );
      }
    } else {
      throw new Error(
        `Unsupported token type ${type} when fetching token metadata`,
      );
    }
  }

  /**
   * Fetches ERC20 metadata from a token contract.
   *
   * @param tokenAddress - The address of the token contract.
   * @returns Token metadata including name, symbol, and decimals.
   */
  async fetchERC20Metadata(tokenAddress: Address): Promise<TokenMetadata> {
    const contract = getStarknetHypERC20Contract(tokenAddress, this.provider);

    const [nameBytes, symbolBytes, decimals] = await Promise.all([
      contract.name(),
      contract.symbol(),
      contract.decimals(),
    ]);

    return {
      name: nameBytes,
      symbol: symbolBytes,
      decimals: Number(decimals),
    };
  }

  /**
   * Fetches the remote routers configuration.
   *
   * @param warpRouteAddress - The address of the token contract.
   * @returns Map of remote domain IDs to router addresses.
   */
  async fetchRemoteRouters(warpRouteAddress: Address): Promise<RemoteRouters> {
    const contract = getStarknetHypERC20Contract(
      warpRouteAddress,
      this.provider,
    );

    const domains: number[] = (await contract.domains()).map((d) => Number(d));

    const routers: RemoteRouters = {};

    for (const domain of domains) {
      const routerUint256 = await contract.routers(domain);
      // Convert Uint256 to Address format
      const routerAddress = num.toHex64(
        uint256.uint256ToBN(routerUint256 as Uint256).toString(),
      );
      routers[domain.toString()] = { address: routerAddress };
    }

    return routers;
  }

  /**
   * Fetches destination gas configuration.
   *
   * @param warpRouteAddress - The address of the token contract.
   * @returns Map of domain IDs to gas amounts.
   */
  async fetchDestinationGas(
    warpRouteAddress: Address,
  ): Promise<DestinationGas> {
    const contract = getStarknetHypERC20Contract(
      warpRouteAddress,
      this.provider,
    );

    const domains: number[] = (await contract.domains()).map((d) => Number(d));

    const destinationGas: DestinationGas = {};

    for (const domain of domains) {
      const gasAmount = await contract.destination_gas(domain);
      destinationGas[domain.toString()] = gasAmount.toString();
    }

    return destinationGas;
  }
}
