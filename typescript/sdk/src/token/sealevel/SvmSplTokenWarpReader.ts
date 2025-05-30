import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getTokenMetadata,
} from '@solana/spl-token';
import {
  Commitment,
  Connection,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';

import {
  Address,
  addressToBytes32,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  HYPERLANE_COLLATERAL_TOKEN_ACCOUNT_PDA_SEEDS,
  HYPERLANE_NATIVE_TOKEN_ACCOUNT_PDA_SEEDS,
  HYPERLANE_SYNTHETIC_TOKEN_ACCOUNT_PDA_SEEDS,
  HYPERLANE_TOKEN_METADATA_ACCOUNT_PDA_SEEDS,
} from '../../sealevel/pda.js';
import { ChainNameOrId } from '../../types.js';
import { TokenType } from '../config.js';
import { DerivedTokenRouterConfig } from '../types.js';

import {
  getLegacySPLTokenMetadata,
  getSealevelHypTokenAccountData,
} from './token.js';

export class SvmSplTokenWarpRouteReader {
  protected readonly logger = rootLogger.child({
    module: SvmSplTokenWarpRouteReader.name,
  });

  protected readonly connection: Connection;
  protected readonly commitment: Commitment = 'finalized';
  protected readonly deriveTokenConfigMap: Record<
    TokenType,
    ((address: PublicKey) => Promise<DerivedTokenRouterConfig>) | null
  >;
  protected readonly pdaSeedsByTokenType: Record<TokenType, string[] | null>;

  constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly multiProvider: MultiProtocolProvider<{
      mailbox?: Address;
    }>,
  ) {
    this.connection = multiProvider.getSolanaWeb3Provider(chain);

    this.deriveTokenConfigMap = {
      [TokenType.native]: this.deriveHypNativeTokenConfig.bind(this),
      [TokenType.collateral]: this.deriveHypCollateralTokenConfig.bind(this),
      [TokenType.synthetic]: this.deriveHypSyntheticTokenConfig.bind(this),
      [TokenType.XERC20]: null,
      [TokenType.XERC20Lockbox]: null,
      [TokenType.collateralFiat]: null,
      [TokenType.collateralVault]: null,
      [TokenType.collateralVaultRebase]: null,
      [TokenType.syntheticRebase]: null,
      [TokenType.nativeScaled]: null,
      [TokenType.collateralUri]: null,
      [TokenType.syntheticUri]: null,
    };

    this.pdaSeedsByTokenType = {
      [TokenType.native]: HYPERLANE_NATIVE_TOKEN_ACCOUNT_PDA_SEEDS,
      [TokenType.collateral]: HYPERLANE_COLLATERAL_TOKEN_ACCOUNT_PDA_SEEDS,
      [TokenType.synthetic]: HYPERLANE_SYNTHETIC_TOKEN_ACCOUNT_PDA_SEEDS,
      [TokenType.XERC20]: null,
      [TokenType.XERC20Lockbox]: null,
      [TokenType.collateralFiat]: null,
      [TokenType.collateralVault]: null,
      [TokenType.collateralVaultRebase]: null,
      [TokenType.syntheticRebase]: null,
      [TokenType.nativeScaled]: null,
      [TokenType.collateralUri]: null,
      [TokenType.syntheticUri]: null,
    };
  }

  async deriveWarpRouteConfig(
    warpRouteAddress: Address,
  ): Promise<DerivedTokenRouterConfig> {
    this.logger.debug(
      `Reading warp token at address "${warpRouteAddress}" on chain "${this.chain}"`,
    );
    const programId = new PublicKey(warpRouteAddress);

    const tokenType = await this.getTokenTypeForProgram(programId);

    const deriveFunction = this.deriveTokenConfigMap[tokenType];
    if (!deriveFunction) {
      throw new Error(
        `Provided unsupported token type "${tokenType}" when fetching token metadata on chain "${this.chain}" at address "${warpRouteAddress}"`,
      );
    }

    return deriveFunction(programId);
  }

  protected async getTokenTypeForProgram(
    programId: PublicKey,
  ): Promise<TokenType> {
    for (const [tokenType, seeds] of Object.entries(this.pdaSeedsByTokenType)) {
      if (!seeds) {
        continue;
      }

      this.logger.debug(
        `Checking if token at address "${programId.toString()}" on chain "${this.chain}" is "${tokenType}"`,
      );

      const accountInfo = await this.connection.getAccountInfo(
        BaseSealevelAdapter.derivePda(seeds, programId),
      );

      if (!accountInfo) {
        this.logger.debug(
          `Token at address "${programId.toString()}" on chain "${this.chain}" is not of type "${tokenType}" because it's PDA does not exist`,
        );
        continue;
      }

      if (
        accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ||
        accountInfo.owner.equals(TOKEN_PROGRAM_ID)
      ) {
        const escrowAccount = await this.connection.getAccountInfo(
          BaseSealevelAdapter.derivePda(
            HYPERLANE_COLLATERAL_TOKEN_ACCOUNT_PDA_SEEDS,
            programId,
          ),
        );

        // if the escrow account does not exist we can be sure that the token is a synthetic
        return escrowAccount ? TokenType.collateral : TokenType.synthetic;
      }

      if (accountInfo.owner.equals(SystemProgram.programId)) {
        return TokenType.native;
      }
    }

    throw new Error(
      `Could not derive token type for address "${programId.toString()}" on chain ${this.chain}`,
    );
  }

  private async getTokenAccountData(
    programId: PublicKey,
  ): Promise<Omit<DerivedTokenRouterConfig, 'type'>> {
    const tokenData = await getSealevelHypTokenAccountData(
      this.connection,
      BaseSealevelAdapter.derivePda(
        HYPERLANE_TOKEN_METADATA_ACCOUNT_PDA_SEEDS,
        programId,
      ),
    );

    return {
      // TODO: use the overhead igp instead
      hook: tokenData.interchain_gas_paymaster_pubkey
        ? tokenData.interchain_gas_paymaster_pubkey.toString()
        : SystemProgram.programId.toString(),
      interchainSecurityModule: tokenData.interchain_security_module_pubkey
        ? tokenData.interchain_security_module_pubkey.toString()
        : SystemProgram.programId.toString(),
      mailbox: tokenData.mailbox_pubkey.toString(),
      owner: tokenData.owner_pub_key!.toString(),
      decimals: tokenData.decimals,
      isNft: false,
      destinationGas: Object.fromEntries(
        Array.from(tokenData.destination_gas?.entries() ?? []).map(
          ([domain, gas]) => [domain.toString(), gas.toString()],
        ),
      ),
      remoteRouters: Object.fromEntries(
        Array.from(tokenData.remote_router_pubkeys?.entries() ?? []).map(
          ([domain, routerAddress]) => [
            domain.toString(),
            { address: addressToBytes32(routerAddress.toString()) },
          ],
        ),
      ),
    };
  }

  private async deriveHypNativeTokenConfig(
    programId: PublicKey,
  ): Promise<DerivedTokenRouterConfig> {
    const tokenData = await this.getTokenAccountData(programId);

    const chainMetadata = this.multiProvider.tryGetChainMetadata(this.chain);

    assert(
      chainMetadata?.nativeToken,
      `Native token metadata must be defined on chain "${this.chain}"`,
    );
    const { name, symbol } = chainMetadata.nativeToken;

    return {
      ...tokenData,
      type: TokenType.native,
      isNft: false,
      symbol,
      name,
    };
  }

  private async deriveHypCollateralTokenConfig(
    programId: PublicKey,
  ): Promise<DerivedTokenRouterConfig> {
    const escrowAccountAddress = BaseSealevelAdapter.derivePda(
      HYPERLANE_COLLATERAL_TOKEN_ACCOUNT_PDA_SEEDS,
      programId,
    );

    const [tokenData, escrowAccountInfo] = await Promise.all([
      this.getTokenAccountData(programId),
      this.connection.getAccountInfo(escrowAccountAddress),
    ]);

    assert(
      escrowAccountInfo,
      `Escrow account not found for token at address "${programId.toString()}" on chain "${this.chain}"`,
    );
    assert(
      escrowAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ||
        escrowAccountInfo.owner.equals(TOKEN_PROGRAM_ID),
      `Escrow account at "${escrowAccountAddress.toString()}" on chain "${this.chain}" is not an Associated Token Account`,
    );

    const escrowAccount = await getAccount(
      this.connection,
      escrowAccountAddress,
      this.commitment,
      escrowAccountInfo.owner,
    );

    const metadata = escrowAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? await getTokenMetadata(
          this.connection,
          escrowAccount.mint,
          this.commitment,
          TOKEN_2022_PROGRAM_ID,
        )
      : await getLegacySPLTokenMetadata(this.connection, escrowAccount.mint);

    assert(
      metadata,
      `Metadata not found for "${TokenType.collateral}" token on chain "${this.chain}" and address ${programId.toBase58()}`,
    );

    return {
      ...tokenData,
      type: TokenType.collateral,
      token: escrowAccount.mint.toString(),
      isNft: false,
      name: metadata.name,
      symbol: metadata.symbol,
    };
  }

  private async deriveHypSyntheticTokenConfig(
    programId: PublicKey,
  ): Promise<DerivedTokenRouterConfig> {
    const mintAccountAddress = BaseSealevelAdapter.derivePda(
      HYPERLANE_SYNTHETIC_TOKEN_ACCOUNT_PDA_SEEDS,
      programId,
    );

    const [tokenData, metadata] = await Promise.all([
      this.getTokenAccountData(programId),
      getTokenMetadata(
        this.connection,
        mintAccountAddress,
        this.commitment,
        TOKEN_2022_PROGRAM_ID,
      ),
    ]);

    assert(
      metadata,
      `Metadata not found for "${TokenType.synthetic}" token on chain "${this.chain}" and address ${programId.toBase58()}`,
    );

    return {
      ...tokenData,
      type: TokenType.synthetic,
      name: metadata.name,
      symbol: metadata.symbol,
      isNft: false,
    };
  }
}
