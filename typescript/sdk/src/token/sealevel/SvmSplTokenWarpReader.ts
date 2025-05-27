import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Commitment, Connection, PublicKey } from '@solana/web3.js';

import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainNameOrId } from '../../types.js';
import { TokenType } from '../config.js';
import { DerivedTokenRouterConfig, HypTokenConfig } from '../types.js';

import {
  HYPERLANE_COLLATERAL_TOKEN_PDA_SEEDS,
  HYPERLANE_NATIVE_TOKEN_PDA_SEEDS,
  HYPERLANE_SYNTHETIC_TOKEN_PDA_SEEDS,
  SvmSystemProgram,
} from './pda.js';

export class SvmSplTokenWarpRouteReader {
  protected readonly logger = rootLogger.child({
    module: SvmSplTokenWarpRouteReader.name,
  });

  protected readonly connection: Connection;
  protected readonly commitment: Commitment = 'confirmed';

  constructor(
    protected readonly chain: ChainNameOrId,
    protected readonly multiProvider: MultiProtocolProvider,
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
    ((address: Address) => Promise<HypTokenConfig>) | null
  >;

  async deriveWarpRouteConfig(
    warpRouteAddress: Address,
  ): Promise<DerivedTokenRouterConfig> {
    this.logger.info(
      `Reading warp token at address "${warpRouteAddress}" on chain "${this.chain}"`,
    );
    const programId = new PublicKey(warpRouteAddress);

    const tokenType = await this.getTokenTypeForProgram(programId);

    console.log(tokenType);

    return {} as DerivedTokenRouterConfig;
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

  private deriveHypNativeTokenConfig(
    _programId: Address,
  ): Promise<DerivedTokenRouterConfig> {
    throw new Error('Not impl');
  }

  private deriveHypCollateralTokenConfig(
    _programId: Address,
  ): Promise<DerivedTokenRouterConfig> {
    throw new Error('Not impl');
  }

  private deriveHypSyntheticTokenConfig(
    _programId: Address,
  ): Promise<DerivedTokenRouterConfig> {
    throw new Error('Not impl');
  }
}
