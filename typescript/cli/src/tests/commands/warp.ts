import { $, type ProcessPromise } from 'zx';

import {
  type WarpCoreConfig,
  WarpCoreConfigSchema,
  type WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

import { localTestRunCmdPrefix } from './helpers.js';
import { syncWarpDeployConfigToRegistry } from './warp-config-sync.js';

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
    outputPath,
    warpRouteId,
  }: {
    chain?: string;
    warpAddress?: string;
    warpRouteId?: string;
    outputPath?: string;
  }): ProcessPromise {
    return $`${localTestRunCmdPrefix()} hyperlane warp read \
            --registry ${this.registryPath} \
            ${warpAddress ? ['--address', warpAddress] : []} \
            ${chain ? ['--chain', chain] : []} \
            ${warpRouteId ? ['--warp-route-id', warpRouteId] : []} \
            --verbosity debug \
            ${outputPath || this.outputPath ? ['--out', outputPath || this.outputPath] : []}`;
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
    hypKey,
    skipConfirmationPrompts,
    privateKey,
    warpRouteId,
    warpDeployPath,
    extraArgs,
  }: {
    hypKey?: string;
    skipConfirmationPrompts?: boolean;
    privateKey?: string;
    warpRouteId?: string;
    warpDeployPath?: string;
    extraArgs?: string[];
  }): ProcessPromise {
    this.syncWarpDeployConfigToRegistry(warpRouteId, warpDeployPath);
    return $`${
      hypKey ? [`${this.hypKeyEnvName}=${hypKey}`] : []
    } ${localTestRunCmdPrefix()} hyperlane warp deploy \
          --registry ${this.registryPath} \
          ${privateKey ? [this.privateKeyFlag, privateKey] : []} \
          --verbosity debug \
          ${warpRouteId ? ['--warp-route-id', warpRouteId] : []} \
          ${skipConfirmationPrompts ? ['--yes'] : []} \
          ${extraArgs ? extraArgs : []}
          `;
  }

  /**
   * Deploys the Warp route to the specified chain using the provided config.
   */
  public deploy(
    privateKey: string,
    warpRouteId: string,
    warpDeployPath?: string,
  ): ProcessPromise {
    return this.deployRaw({
      privateKey,
      skipConfirmationPrompts: true,
      warpRouteId,
      warpDeployPath,
    });
  }

  public applyRaw({
    strategyUrl,
    warpRouteId,
    privateKey,
    relay,
    hypKey,
    extraArgs,
    skipConfirmationPrompts,
  }: {
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
          ${strategyUrl ? ['--strategy', strategyUrl] : []} \
          ${warpRouteId ? ['--warp-route-id', warpRouteId] : []} \
          ${privateKey ? [this.privateKeyFlag, privateKey] : []} \
          --verbosity debug \
          ${relay ? ['--relay'] : []} \
          ${skipConfirmationPrompts ? ['--yes'] : []} \
          ${extraArgs ? extraArgs : []}
          `;
  }

  private syncWarpDeployConfigToRegistry(
    warpRouteId?: string,
    warpDeployPath?: string,
  ) {
    if (!warpRouteId || !warpDeployPath) return;
    syncWarpDeployConfigToRegistry({
      warpDeployPath,
      warpRouteId,
      registryPath: this.registryPath,
    });
  }

  /**
   * Creates the SVM Address Lookup Tables for a warp route and persists
   * them to the registry. Wraps `hyperlane warp alt create`.
   *
   * `force` recreates warp-specific ALTs while reusing the registered
   * core ALT; `fullForce` recreates everything.
   */
  public altCreate(
    privateKey: string,
    warpRouteId: string,
    options?: { chain?: string; force?: boolean; fullForce?: boolean },
  ): ProcessPromise {
    return $`${localTestRunCmdPrefix()} hyperlane warp alt create \
          --registry ${this.registryPath} \
          --warp-route-id ${warpRouteId} \
          ${options?.chain ? ['--chain', options.chain] : []} \
          ${options?.force ? ['--force'] : []} \
          ${options?.fullForce ? ['--full-force'] : []} \
          ${this.privateKeyFlag} ${privateKey} \
          --verbosity debug \
          --yes`;
  }

  /**
   * Reads the on-chain contents of the SVM Address Lookup Tables
   * registered for a warp route. Wraps `hyperlane warp alt read`.
   */
  public altRead(warpRouteId: string, chain?: string): ProcessPromise {
    return $`${localTestRunCmdPrefix()} hyperlane warp alt read \
          --registry ${this.registryPath} \
          --warp-route-id ${warpRouteId} \
          ${chain ? ['--chain', chain] : []} \
          --verbosity debug`;
  }

  /**
   * Diffs the on-chain SVM Address Lookup Tables registered for a warp
   * route against what the SDK would regenerate. Wraps
   * `hyperlane warp alt check`.
   */
  public altCheck(warpRouteId: string, chain?: string): ProcessPromise {
    return $`${localTestRunCmdPrefix()} hyperlane warp alt check \
          --registry ${this.registryPath} \
          --warp-route-id ${warpRouteId} \
          ${chain ? ['--chain', chain] : []} \
          --verbosity debug`;
  }

  public sendRaw({
    origin,
    destination,
    warpRouteId,
    amount,
    recipient,
    relay,
    quick,
    chains,
    roundTrip,
    skipValidation,
    privateKey,
    hypKey,
    extraArgs,
  }: {
    origin?: string;
    destination?: string;
    warpRouteId?: string;
    amount?: number | string;
    recipient?: string;
    relay?: boolean;
    quick?: boolean;
    chains?: string[];
    roundTrip?: boolean;
    skipValidation?: boolean;
    privateKey?: string;
    hypKey?: string;
    extraArgs?: string[];
  }): ProcessPromise {
    return $`${
      hypKey ? [`${this.hypKeyEnvName}=${hypKey}`] : []
    } ${localTestRunCmdPrefix()} hyperlane warp send \
          --registry ${this.registryPath} \
          ${origin ? ['--origin', origin] : []} \
          ${destination ? ['--destination', destination] : []} \
          ${warpRouteId ? ['--warp-route-id', warpRouteId] : []} \
          ${amount !== undefined ? ['--amount', amount] : []} \
          ${recipient ? ['--recipient', recipient] : []} \
          ${relay ? ['--relay'] : []} \
          ${quick ? ['--quick'] : []} \
          ${chains?.length ? ['--chains', ...chains] : []} \
          ${roundTrip ? ['--round-trip'] : []} \
          ${skipValidation ? ['--skip-validation'] : []} \
          ${privateKey ? [this.privateKeyFlag, privateKey] : []} \
          --verbosity debug \
          --yes \
          ${extraArgs ? extraArgs : []}
          `;
  }
}
