import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Commitment,
  Connection,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';

import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import {
  HYPERLANE_COLLATERAL_TOKEN_PDA_SEEDS,
  HYPERLANE_NATIVE_TOKEN_PDA_SEEDS,
  HYPERLANE_SYNTHETIC_TOKEN_PDA_SEEDS,
  HYPERLANE_TOKEN_METADATA_ACCOUNT_PDA_SEEDS,
  SvmSystemProgram,
} from '../../sealevel/pda.js';
import { ChainNameOrId } from '../../types.js';
import { TokenType } from '../config.js';
import { DerivedTokenRouterConfig, HypTokenConfig } from '../types.js';

import { getSealevelHypTokenAccountData } from './token.js';

export class SvmSplTokenWarpRouteReader {
  protected readonly logger = rootLogger.child({
    module: SvmSplTokenWarpRouteReader.name,
  });

  protected readonly connection: Connection;
  protected readonly commitment: Commitment = 'confirmed';

  constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly multiProvider: MultiProtocolProvider<{
      mailbox?: Address;
    }>,
  ) {
    this.connection = multiProvider.getSolanaWeb3Provider(chain);

    this.deriveTokenConfigMap = {
      [TokenType.XERC20]: null,
      [TokenType.XERC20Lockbox]: null,
      [TokenType.collateral]: this.deriveHypCollateralTokenConfig.bind(this),
      [TokenType.collateralFiat]: null,
      [TokenType.collateralVault]: null,
      [TokenType.collateralVaultRebase]: null,
      [TokenType.native]: this.deriveHypNativeTokenConfig.bind(this),
      [TokenType.synthetic]: this.deriveHypSyntheticTokenConfig.bind(this),
      [TokenType.syntheticRebase]: null,
      [TokenType.nativeScaled]: null,
      [TokenType.collateralUri]: null,
      [TokenType.syntheticUri]: null,
    };
  }

  protected readonly deriveTokenConfigMap!: Record<
    TokenType,
    ((address: PublicKey) => Promise<HypTokenConfig>) | null
  >;

  async deriveWarpRouteConfig(
    warpRouteAddress: Address,
  ): Promise<DerivedTokenRouterConfig> {
    this.logger.info(
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

    const config = await deriveFunction(programId);

    return config as any;
  }

  // Stub: you will need to provide this based on your setup
  protected async getTokenTypeForProgram(
    programId: PublicKey,
  ): Promise<TokenType> {
    const seedsByTokenType = [
      HYPERLANE_NATIVE_TOKEN_PDA_SEEDS,
      HYPERLANE_SYNTHETIC_TOKEN_PDA_SEEDS,
      HYPERLANE_COLLATERAL_TOKEN_PDA_SEEDS,
    ];

    for (const seeds of seedsByTokenType) {
      const [tokenAccount, _bump] = PublicKey.findProgramAddressSync(
        seeds,
        programId,
      );

      const accountInfo = await this.connection.getAccountInfo(tokenAccount);

      if (!accountInfo) {
        continue;
      }

      // TODO: correctly derive if it is a collateral or synthetic
      if (
        accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ||
        accountInfo.owner.equals(TOKEN_PROGRAM_ID)
      ) {
        return TokenType.synthetic;
      }

      if (accountInfo.owner.equals(SvmSystemProgram)) {
        return TokenType.native;
      }
    }

    throw new Error(
      `Could not derive token type for address "${programId}" on chain ${this.chain}`,
    );
  }

  private async deriveHypNativeTokenConfig(
    programId: PublicKey,
  ): Promise<DerivedTokenRouterConfig> {
    const tokenAccount = BaseSealevelAdapter.derivePda(
      HYPERLANE_TOKEN_METADATA_ACCOUNT_PDA_SEEDS,
      programId,
    );

    const tokenData = await getSealevelHypTokenAccountData(
      this.connection,
      tokenAccount,
    );

    const chainMetadata = this.multiProvider.tryGetChainMetadata(this.chain);

    assert(chainMetadata?.nativeToken, '');
    const { name, symbol } = chainMetadata.nativeToken;

    return {
      type: TokenType.native,
      hook: tokenData.interchain_gas_paymaster_pubkey
        ? tokenData.interchain_gas_paymaster_pubkey.toBase58()
        : SystemProgram.programId.toBase58(),
      interchainSecurityModule: tokenData.interchain_security_module
        ? PublicKey.decode(Buffer.from(tokenData.interchain_security_module))
        : SystemProgram.programId.toBase58(),
      mailbox: PublicKey.decode(Buffer.from(tokenData.mailbox)),
      owner: PublicKey.decode(Buffer.from(tokenData.owner!)),
      decimals: tokenData.decimals,
      isNft: false,
      symbol,
      name,
      destinationGas: Object.fromEntries(
        Array.from(tokenData.destination_gas?.entries() ?? []).map(
          ([domain, gas]) => [domain.toString(), gas.toString()],
        ),
      ),
      remoteRouters: Object.fromEntries(
        Array.from(tokenData.remote_router_pubkeys?.entries() ?? []).map(
          ([domain, routerAddress]) => [
            domain.toString(),
            { address: routerAddress.toString() },
          ],
        ),
      ),
    };
  }

  private deriveHypCollateralTokenConfig(
    _programId: PublicKey,
  ): Promise<DerivedTokenRouterConfig> {
    throw new Error('Not impl');
  }

  private deriveHypSyntheticTokenConfig(
    _programId: PublicKey,
  ): Promise<DerivedTokenRouterConfig> {
    throw new Error('Not impl');
  }
}
