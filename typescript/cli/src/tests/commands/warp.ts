import { $, ProcessPromise } from 'zx';

import {
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

import { localTestRunCmdPrefix } from './helpers.js';

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
  private getDeployedWarpAddress(chain: string, warpCorePath: string) {
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCorePath);
    WarpCoreConfigSchema.parse(warpCoreConfig);
    return warpCoreConfig.tokens.find((t) => t.chainName === chain)!
      .addressOrDenom;
  }

  public readRaw({
    chain,
    warpAddress,
    symbol,
    outputPath,
  }: {
    chain?: string;
    symbol?: string;
    warpAddress?: string;
    outputPath?: string;
  }): ProcessPromise {
    return $`${localTestRunCmdPrefix()} hyperlane warp read \
            --registry ${this.registryPath} \
            ${warpAddress ? ['--address', warpAddress] : []} \
            ${chain ? ['--chain', chain] : []} \
            ${symbol ? ['--symbol', symbol] : []} \
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
  }: {
    warpCorePath?: string;
    warpDeployPath?: string;
    hypKey?: string;
    skipConfirmationPrompts?: boolean;
    privateKey?: string;
    warpRouteId?: string;
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
          ${skipConfirmationPrompts ? ['--yes'] : []}`;
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
}
