import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { TokenType, WarpConfig } from '@hyperlane-xyz/provider-sdk/warp';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

export class AltVMDeployer {
  protected logger: ReturnType<typeof rootLogger.child<never>>;

  constructor(
    protected readonly signersMap: Record<
      string,
      AltVM.ISigner<AnnotatedTx, TxReceipt>
    >,
  ) {
    this.logger = rootLogger.child({ module: 'AltVMDeployer' });
  }

  async deploy(
    configMap: Record<string, WarpConfig>,
  ): Promise<Record<string, Address>> {
    const result: Record<string, Address> = {};

    for (const chain of Object.keys(configMap)) {
      const config = configMap[chain];
      assert(this.signersMap[chain], `No signer configured for ${chain}`);
      assert(config, `No config configured for ${chain}`);

      this.logger.info(`Deploying ${config.type} token to chain ${chain}`);

      if (config.type === TokenType.collateral) {
        result[chain] = await this.deployCollateralToken(
          chain,
          config.mailbox,
          config.token,
        );
      } else if (config.type === TokenType.synthetic) {
        result[chain] = await this.deploySyntheticToken(
          chain,
          config.mailbox,
          config.name,
          config.symbol,
          config.decimals,
        );
      } else {
        // This should never happen with proper type guards above
        const exhaustiveCheck: never = config;
        throw new Error(
          `Token type ${(exhaustiveCheck as any).type} not supported on chain ${chain}`,
        );
      }

      if (
        config.interchainSecurityModule &&
        typeof config.interchainSecurityModule === 'string'
      ) {
        this.logger.info(`Set ISM for token`);

        await this.signersMap[chain].setTokenIsm({
          tokenAddress: result[chain],
          ismAddress: config.interchainSecurityModule,
        });
      }

      this.logger.info(`Successfully deployed contracts on ${chain}`);
    }

    return result;
  }

  private async deployCollateralToken(
    chain: string,
    originMailbox: Address,
    originDenom: string,
  ): Promise<Address> {
    this.logger.info(`Deploying collateral token to ${chain}`);
    const { tokenAddress } = await this.signersMap[chain].createCollateralToken(
      {
        mailboxAddress: originMailbox,
        collateralDenom: originDenom,
      },
    );
    return tokenAddress;
  }

  private async deploySyntheticToken(
    chain: string,
    originMailbox: Address,
    name: string | undefined,
    denom: string | undefined,
    decimals: number | undefined,
  ): Promise<Address> {
    this.logger.info(`Deploying synthetic token to ${chain}`);
    const { tokenAddress } = await this.signersMap[chain].createSyntheticToken({
      mailboxAddress: originMailbox,
      name: name || '',
      denom: denom || '',
      decimals: decimals || 0,
    });
    return tokenAddress;
  }
}
