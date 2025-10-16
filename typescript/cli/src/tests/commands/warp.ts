import { Wallet } from 'ethers';
import { $, ProcessPromise } from 'zx';

import {
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';
import { HYP_KEY_BY_PROTOCOL } from '../constants.js';

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
  private getDeployedWarpAddress(chain: string, warpCorePath: string) {
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCorePath);
    WarpCoreConfigSchema.parse(warpCoreConfig);
    return warpCoreConfig.tokens.find((t) => t.chainName === chain)!
      .addressOrDenom;
  }

  public initRaw({
    privateKey,
    hypKey,
    skipConfirmationPrompts,
    advanced,
    outputPath,
  }: {
    privateKey?: string;
    hypKey?: string;
    skipConfirmationPrompts?: boolean;
    outputPath?: string;
    advanced?: boolean;
  }): ProcessPromise {
    return $`${
      hypKey ? ['HYP_KEY=' + hypKey] : []
    } ${localTestRunCmdPrefix()} hyperlane warp init \
          --registry ${this.registryPath} \
          ${outputPath ? ['--out', outputPath] : []} \
          ${privateKey ? [this.privateKeyFlag, privateKey] : []} \
          ${advanced ? ['--advanced'] : []} \
          --verbosity debug \
          ${skipConfirmationPrompts ? ['--yes'] : []}`;
  }

  public init(outputPath: string, privateKey?: string): ProcessPromise {
    return this.initRaw({
      outputPath,
      privateKey,
      skipConfirmationPrompts: true,
    });
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

  public checkRaw({
    warpDeployPath,
    symbol,
    warpCoreConfigPath,
    warpRouteId,
  }: {
    symbol?: string;
    warpDeployPath?: string;
    warpCoreConfigPath?: string;
    warpRouteId?: string;
  }): ProcessPromise {
    return $`${localTestRunCmdPrefix()} hyperlane warp check \
          --registry ${this.registryPath} \
          ${symbol ? ['--symbol', symbol] : []} \
          --verbosity debug \
          ${warpDeployPath ? ['--config', warpDeployPath] : []} \
          ${warpCoreConfigPath ? ['--warp', warpCoreConfigPath] : []} \
          ${warpRouteId ? ['--warpRouteId', warpRouteId] : []}`;
  }

  public check(
    warpDeployPath: string,
    symbol: string,
    warpCoreConfigPath?: string,
  ): ProcessPromise {
    return this.checkRaw({
      warpDeployPath,
      symbol,
      warpCoreConfigPath,
    });
  }

  sendAndRelay({
    relay = true,
    destination,
    origin,
    value = 1,
    warpCorePath,
    privateKey,
    chains,
    roundTrip,
  }: {
    origin?: string;
    destination?: string;
    warpCorePath: string;
    relay?: boolean;
    value?: number | string;
    privateKey?: string;
    chains?: string;
    roundTrip?: boolean;
  }): ProcessPromise {
    return $`${localTestRunCmdPrefix()} hyperlane warp send \
          ${relay ? '--relay' : []} \
          --registry ${this.registryPath} \
          ${origin ? ['--origin', origin] : []} \
        ${destination ? ['--destination', destination] : []} \
          --warp ${warpCorePath} \
          ${privateKey ? [this.privateKeyFlag, privateKey] : []} \ \
          --verbosity debug \
          --yes \
                ${chains ? ['--chains', chains] : []} \
        ${roundTrip ? ['--round-trip'] : []} \
          --amount ${value}`;
  }

  public hyperlaneRelayer(
    chains: string[],
    warp?: string,
    privateKey?: string,
  ) {
    const keyToUse = privateKey ?? HYP_KEY_BY_PROTOCOL.ethereum;

    return $`${localTestRunCmdPrefix()} hyperlane relayer \
          --registry ${this.registryPath} \
          --chains ${chains.join(',')} \
          --warp ${warp ?? ''} \
          --key ${keyToUse} \
          --verbosity debug \
          --yes`;
  }

  warpRebalancer(
    checkFrequency: number,
    config: string,
    withMetrics: boolean,
    monitorOnly?: boolean,
    manual?: boolean,
    origin?: string,
    destination?: string,
    amount?: string,
    key?: string,
    explorerUrl?: string,
  ): ProcessPromise {
    const keyToUse = key ?? HYP_KEY_BY_PROTOCOL.ethereum;
    const rebalancerAddress = new Wallet(keyToUse).address;

    return $`${explorerUrl ? [`EXPLORER_API_URL=${explorerUrl}`] : []} \
          REBALANCER=${rebalancerAddress} ${localTestRunCmdPrefix()} \
          hyperlane warp rebalancer \
          --registry ${this.registryPath} \
          --checkFrequency ${checkFrequency} \
          --config ${config} \
          --key ${keyToUse} \
          --verbosity debug \
          --withMetrics ${withMetrics ? ['true'] : ['false']} \
          --monitorOnly ${monitorOnly ? ['true'] : ['false']} \
          ${manual ? ['--manual'] : []} \
          ${origin ? ['--origin', origin] : []} \
          ${destination ? ['--destination', destination] : []} \
          ${amount ? ['--amount', amount] : []}`;
  }
}
