import { ethers, providers } from 'ethers';

import {
  ERC20__factory,
  HypERC20Collateral__factory,
  MailboxClient__factory,
} from '@hyperlane-xyz/core';
import { Address, eqAddress } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { MailboxClientConfig } from '../router/types.js';
import { ChainName } from '../types.js';

import { TokenType } from './config.js';
import { TokenRouterConfig } from './schemas.js';
import { TokenMetadata } from './types.js';

const { AddressZero } = ethers.constants;

export class EvmWarpRouteReader {
  provider: providers.Provider;
  evmHookReader: EvmHookReader;
  evmIsmReader: EvmIsmReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainName,
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
    type = TokenType.collateral,
  ): Promise<TokenRouterConfig> {
    const mailboxClientConfig = await this.fetchMailboxClientConfig(address);

    let token: Address;
    switch (type) {
      case TokenType.collateral:
        token = await HypERC20Collateral__factory.connect(
          address,
          this.provider,
        ).wrappedToken();
        break;
      case TokenType.synthetic:
        token = address;
        break;
      default:
        throw new Error(`Invalid token type: ${type}`);
    }
    const fetchedTokenMetadata = await this.fetchTokenMetadata(token);

    return {
      type,
      token: TokenType.collateral === type ? token : undefined,
      ...mailboxClientConfig,
      ...fetchedTokenMetadata,
    } as TokenRouterConfig;
  }

  /**
   * Fetches the base metadata for a Warp Route contract.
   *
   * @param routerAddress - The address of the Warp Route contract.
   * @returns The base metadata for the Warp Route contract, including the mailbox, owner, wrapped token address, hook, and interchain security module.
   */
  async fetchMailboxClientConfig(
    routerAddress: Address,
  ): Promise<MailboxClientConfig> {
    const warpRoute = MailboxClient__factory.connect(
      routerAddress,
      this.provider,
    );
    const [mailbox, owner, hook, ism] = await Promise.all([
      warpRoute.mailbox(),
      warpRoute.owner(),
      warpRoute.hook(),
      warpRoute.interchainSecurityModule(),
    ]);

    const derivedIsm = eqAddress(ism, AddressZero)
      ? undefined
      : await this.evmIsmReader.deriveIsmConfig(ism);
    // TODO: add after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3667 is fixed
    const derivedHook = eqAddress(hook, AddressZero) ? undefined : hook;

    return {
      mailbox,
      owner,
      hook: derivedHook,
      interchainSecurityModule: derivedIsm,
    };
  }

  /**
   * Fetches the metadata for a token address.
   *
   * @param tokenAddress - The address of the token.
   * @returns A partial ERC20 metadata object containing the token name, symbol, total supply, and decimals.
   */
  async fetchTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
    const erc20 = ERC20__factory.connect(tokenAddress, this.provider);
    const [name, symbol, totalSupply, decimals] = await Promise.all([
      erc20.name(),
      erc20.symbol(),
      erc20.totalSupply(),
      erc20.decimals(),
    ]);

    return { name, symbol, totalSupply: totalSupply.toString(), decimals };
  }
}
