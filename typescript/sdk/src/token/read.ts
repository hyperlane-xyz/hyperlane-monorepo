import { ethers, providers } from 'ethers';

import {
  ERC20__factory,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/core';
import { ERC20Metadata, TokenRouterConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/crud.js';
import { EvmHookReader } from '../hook/read.js';
import { EvmIsmReader } from '../ism/read.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

type WarpRouteBaseMetadata = Record<
  'mailbox' | 'owner' | 'token' | 'hook' | 'interchainSecurityModule',
  string
>;

type DerivedERC20WarpRouteConfig = Omit<TokenRouterConfig, 'type' | 'gas'>;

export class EvmERC20WarpRouteReader {
  provider: providers.Provider;
  evmHookReader: EvmHookReader;
  evmIsmReader: EvmIsmReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    this.provider = this.multiProvider.getProvider(chain);
    this.evmHookReader = new EvmHookReader(multiProvider, chain, concurrency);
    this.evmIsmReader = new EvmIsmReader(multiProvider, chain, concurrency);
  }

  /**
   * Derives the configuration for a Hyperlane ERC20 router contract at the given address.
   *
   * @param address - The address of the Hyperlane ERC20 router contract.
   * @returns The configuration for the Hyperlane ERC20 router.
   *
   */
  async deriveWarpRouteConfig(
    address: Address,
  ): Promise<DerivedERC20WarpRouteConfig> {
    const fetchedBaseMetadata = await this.fetchBaseMetadata(address);
    const fetchedTokenMetadata = await this.fetchTokenMetadata(
      fetchedBaseMetadata.token,
    );

    const results: DerivedERC20WarpRouteConfig = {
      ...fetchedBaseMetadata,
      ...fetchedTokenMetadata,
    };

    if (
      fetchedBaseMetadata.interchainSecurityModule !==
      ethers.constants.AddressZero
    ) {
      results.interchainSecurityModule =
        await this.evmIsmReader.deriveIsmConfig(
          fetchedBaseMetadata.interchainSecurityModule,
        );
    }
    // @todo add after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3667 is fixed
    // if (fetchedBaseMetadata.hook !== ethers.constants.AddressZero) {
    //   results.hook = await this.evmHookReader.deriveHookConfig(
    //     fetchedBaseMetadata.hook,
    //   );
    // }

    return results;
  }

  /**
   * Fetches the base metadata for a Warp Route contract.
   *
   * @param routerAddress - The address of the Warp Route contract.
   * @returns The base metadata for the Warp Route contract, including the mailbox, owner, wrapped token address, hook, and interchain security module.
   */
  async fetchBaseMetadata(
    routerAddress: Address,
  ): Promise<WarpRouteBaseMetadata> {
    const warpRoute = HypERC20Collateral__factory.connect(
      routerAddress,
      this.provider,
    );
    const [mailbox, owner, token, hook, interchainSecurityModule] =
      await Promise.all([
        warpRoute.mailbox(),
        warpRoute.owner(),
        warpRoute.wrappedToken(),
        warpRoute.hook(),
        warpRoute.interchainSecurityModule(),
      ]);

    return {
      mailbox,
      owner,
      token,
      hook,
      interchainSecurityModule,
    };
  }

  /**
   * Fetches the metadata for a token address.
   *
   * @param tokenAddress - The address of the token.
   * @returns A partial ERC20 metadata object containing the token name, symbol, total supply, and decimals.
   */
  async fetchTokenMetadata(tokenAddress: Address): Promise<ERC20Metadata> {
    const erc20 = ERC20__factory.connect(tokenAddress, this.provider);
    const [name, symbol, totalSupply, decimals] = await Promise.all([
      erc20.name(),
      erc20.symbol(),
      erc20.totalSupply(),
      erc20.decimals(),
    ]);

    return { name, symbol, totalSupply, decimals };
  }
}
