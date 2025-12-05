import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { TokenType, WarpConfig } from '@hyperlane-xyz/provider-sdk/warp';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

type AltVMSignerLookup = (
  chain: string,
) => Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>>;

export class AltVMDeployer {
  protected logger: ReturnType<typeof rootLogger.child<never>>;

  constructor(protected readonly altVmSigners: AltVMSignerLookup) {
    this.logger = rootLogger.child({ module: 'AltVMDeployer' });
  }

  async deploy(
    configMap: Record<string, WarpConfig>,
  ): Promise<Record<string, Address>> {
    const result: Record<string, Address> = {};

    for (const chain of Object.keys(configMap)) {
      const config = configMap[chain];
      assert(config, `No config configured for ${chain}`);
      const signer = await this.altVmSigners(chain);

      this.logger.info(`Deploying ${config.type} token to chain ${chain}`);

      if (config.type === TokenType.native) {
        result[chain] = await this.deployNativeToken(
          chain,
          config.mailbox,
          signer,
        );
      } else if (config.type === TokenType.collateral) {
        result[chain] = await this.deployCollateralToken(
          chain,
          config.mailbox,
          config.token,
          signer,
        );
      } else if (config.type === TokenType.synthetic) {
        result[chain] = await this.deploySyntheticToken(
          chain,
          config.mailbox,
          config.name,
          config.symbol,
          config.decimals,
          signer,
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

        await signer.setTokenIsm({
          tokenAddress: result[chain],
          ismAddress: config.interchainSecurityModule,
        });
      }

      this.logger.info(`Successfully deployed contracts on ${chain}`);
    }

    return result;
  }

  private async deployNativeToken(
    chain: string,
    originMailbox: Address,
    signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ): Promise<Address> {
    this.logger.info(`Deploying native token to ${chain}`);
    const { tokenAddress } = await signer.createNativeToken({
      mailboxAddress: originMailbox,
    });
    return tokenAddress;
  }

  private async deployCollateralToken(
    chain: string,
    originMailbox: Address,
    originDenom: string,
    signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ): Promise<Address> {
    this.logger.info(`Deploying collateral token to ${chain}`);
    const { tokenAddress } = await signer.createCollateralToken({
      mailboxAddress: originMailbox,
      collateralDenom: originDenom,
    });
    return tokenAddress;
  }

  private async deploySyntheticToken(
    chain: string,
    originMailbox: Address,
    name: string | undefined,
    denom: string | undefined,
    decimals: number | undefined,
    signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ): Promise<Address> {
    this.logger.info(`Deploying synthetic token to ${chain}`);
    const { tokenAddress } = await signer.createSyntheticToken({
      mailboxAddress: originMailbox,
      name: name || '',
      denom: denom || '',
      decimals: decimals || 0,
    });
    return tokenAddress;
  }
}
