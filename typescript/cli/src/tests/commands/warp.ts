import { $, ProcessPromise } from 'zx';

import {
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

import { localTestRunCmdPrefix } from './helpers.js';

$.verbose = true;

export class HyperlaneE2EWarpTestCommands {
  protected cmdPrefix: string[];

  protected protocol: ProtocolType;
  protected registryPath: string;

  protected outputPath: string;

  constructor(
    protocol: ProtocolType,
    registryPath: string,
    outputPath: string,
  ) {
    this.cmdPrefix = localTestRunCmdPrefix();

    this.protocol = protocol;
    this.registryPath = registryPath;

    this.outputPath = outputPath;
  }

  protected get privateKeyFlag() {
    if (this.protocol === ProtocolType.Ethereum) {
      return '--key';
    }

    return `--key.${this.protocol}`;
  }

  protected get hypKeyEnvName() {
    if (this.protocol === ProtocolType.Ethereum) {
      return 'HYP_KEY';
    }

    return `HYP_KEY_${this.protocol.toUpperCase()}`;
  }

  public setCoreOutputPath(outputPath: string) {
    this.outputPath = outputPath;
  }

  /**
   * Retrieves the deployed Warp address from the Warp core config.
   */
  public getDeployedWarpAddress(chain: string, warpCorePath: string) {
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCorePath);
    WarpCoreConfigSchema.parse(warpCoreConfig);

    const token = warpCoreConfig.tokens.find((t) => t.chainName === chain);
    if (!token?.addressOrDenom) {
      throw new Error(
        `No warp address found for chain ${chain} in ${warpCorePath}`,
      );
    }

    return token.addressOrDenom;
  }

  public readRaw({
    chain,
    warpAddress,
    symbol,
    outputPath,
    warpRouteId,
  }: {
    chain?: string;
    symbol?: string;
    warpAddress?: string;
    warpRouteId?: string;
    outputPath?: string;
  }): ProcessPromise {
    return $`${localTestRunCmdPrefix()} hyperlane warp read \
            --registry ${this.registryPath} \
            ${warpAddress ? ['--address', warpAddress] : []} \
            ${chain ? ['--chain', chain] : []} \
            ${symbol ? ['--symbol', symbol] : []} \
            ${warpRouteId ? ['--warpRouteId', warpRouteId] : []} \
            --verbosity debug \
            ${outputPath || this.outputPath ? ['--config', outputPath || this.outputPath] : []}`;
  }

  public read(chain: string, warpAddress: string): ProcessPromise {
    return this.readRaw({
      chain,
      warpAddress,
    });
  }

  /**
   * Reads the Warp route deployment config to specified output path.
   * @param warpCorePath path to warp core
   * @returns The Warp route deployment config.
   */
  public async readConfig(
    chain: string,
    warpCorePath: string,
  ): Promise<WarpRouteDeployConfigMailboxRequired> {
    const warpAddress = this.getDeployedWarpAddress(chain, warpCorePath);
    await this.read(chain, warpAddress!);
    return readYamlOrJson(this.outputPath);
  }

  /**
   * Deploys the Warp route to the specified chain using the provided config.
   */
  public deployRaw({
    warpCorePath,
    warpDeployPath,
    hypKey,
    skipConfirmationPrompts,
    privateKey,
    warpRouteId,
    extraArgs,
  }: {
    warpCorePath?: string;
    warpDeployPath?: string;
    hypKey?: string;
    skipConfirmationPrompts?: boolean;
    privateKey?: string;
    warpRouteId?: string;
    extraArgs?: string[];
  }): ProcessPromise {
    return $`${
      hypKey ? [`${this.hypKeyEnvName}=${hypKey}`] : []
    } ${localTestRunCmdPrefix()} hyperlane warp deploy \
          --registry ${this.registryPath} \
          ${warpDeployPath ? ['--config', warpDeployPath] : []} \
          ${warpCorePath ? ['--warp', warpCorePath] : []} \
          ${privateKey ? [this.privateKeyFlag, privateKey] : []} \
          --verbosity debug \
          ${warpRouteId ? ['--warpRouteId', warpRouteId] : []} \
          ${skipConfirmationPrompts ? ['--yes'] : []} \
          ${extraArgs ? extraArgs : []}
          `;
  }

  /**
   * Deploys the Warp route to the specified chain using the provided config.
   */
  public deploy(
    warpDeployPath: string,
    privateKey: string,
    warpRouteId?: string,
  ): ProcessPromise {
    return this.deployRaw({
      privateKey,
      warpDeployPath,
      skipConfirmationPrompts: true,
      warpRouteId,
    });
  }

  public applyRaw({
    warpDeployPath,
    warpCorePath,
    strategyUrl,
    warpRouteId,
    privateKey,
    relay,
    hypKey,
    extraArgs,
    skipConfirmationPrompts,
  }: {
    warpDeployPath?: string;
    warpCorePath?: string;
    strategyUrl?: string;
    warpRouteId?: string;
    privateKey?: string;
    hypKey?: string;
    relay?: boolean;
    skipConfirmationPrompts?: boolean;
    extraArgs?: string[];
  }): ProcessPromise {
    return $` ${
      hypKey ? [`${this.hypKeyEnvName}=${hypKey}`] : []
    } ${localTestRunCmdPrefix()} hyperlane warp apply \
          --registry ${this.registryPath} \
          ${warpDeployPath ? ['--config', warpDeployPath] : []} \
          ${warpCorePath ? ['--warp', warpCorePath] : []} \
          ${strategyUrl ? ['--strategy', strategyUrl] : []} \
          ${warpRouteId ? ['--warpRouteId', warpRouteId] : []} \
          ${privateKey ? [this.privateKeyFlag, privateKey] : []} \
          --verbosity debug \
          ${relay ? ['--relay'] : []} \
          ${skipConfirmationPrompts ? ['--yes'] : []} \
          ${extraArgs ? extraArgs : []}
          `;
  }
}
