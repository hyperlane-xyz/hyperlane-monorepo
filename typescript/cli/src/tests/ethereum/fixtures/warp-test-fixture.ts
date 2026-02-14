import {
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { createSnapshot, restoreSnapshot } from '../commands/helpers.js';

export interface WarpTestFixtureConfig {
  initialDeployConfig: WarpRouteDeployConfig;
  deployConfigPath: string;
  coreConfigPath: string;
}

export interface SnapshotConfig {
  rpcUrl: string;
  chainName: string;
}

/**
 * Reusable test fixture for Warp route tests.
 *
 * Provides config management and EVM snapshot utilities for fast test isolation.
 */
export class WarpTestFixture {
  private deployConfig: WarpRouteDeployConfig;
  private baselineDeployConfig: WarpRouteDeployConfig;
  private coreConfig?: WarpCoreConfig;
  private snapshots = new Map<string, string>();

  constructor(private readonly config: WarpTestFixtureConfig) {
    this.baselineDeployConfig = this.cloneConfig(config.initialDeployConfig);
    this.deployConfig = this.cloneConfig(config.initialDeployConfig);
  }

  private cloneConfig(config: WarpRouteDeployConfig): WarpRouteDeployConfig {
    return JSON.parse(JSON.stringify(config));
  }

  writeConfigs(deployConfig?: WarpRouteDeployConfig): void {
    const configToWrite = deployConfig || this.deployConfig;
    writeYamlOrJson(this.config.deployConfigPath, configToWrite);

    if (this.coreConfig) {
      writeYamlOrJson(this.config.coreConfigPath, this.coreConfig);
    }
  }

  restoreDeployConfig(): void {
    this.deployConfig = this.cloneConfig(this.baselineDeployConfig);
    writeYamlOrJson(this.config.deployConfigPath, this.deployConfig);
  }

  restoreConfigs(): void {
    this.restoreDeployConfig();

    if (this.coreConfig) {
      writeYamlOrJson(this.config.coreConfigPath, this.coreConfig);
    }
  }

  updateDeployConfig(config: WarpRouteDeployConfig): void {
    this.baselineDeployConfig = this.cloneConfig(config);
    this.deployConfig = this.cloneConfig(config);
  }

  loadCoreConfig(): void {
    this.coreConfig = readYamlOrJson(this.config.coreConfigPath);
  }

  setCoreConfig(config: WarpCoreConfig): void {
    this.coreConfig = config;
  }

  getDeployConfig(): WarpRouteDeployConfig {
    return this.deployConfig;
  }

  getCoreConfig(): WarpCoreConfig | undefined {
    return this.coreConfig;
  }

  async createSnapshot(snapshotConfig: SnapshotConfig): Promise<string> {
    const snapshotId = await createSnapshot(snapshotConfig.rpcUrl);
    this.snapshots.set(snapshotConfig.chainName, snapshotId);
    return snapshotId;
  }

  async restoreSnapshot(snapshotConfig: SnapshotConfig): Promise<void> {
    const key = snapshotConfig.chainName;
    const snapshotId = this.snapshots.get(key);

    if (!snapshotId) {
      throw new Error(
        `No snapshot found for ${key}. Call snapshot() first in before() hook.`,
      );
    }

    await restoreSnapshot(snapshotConfig.rpcUrl, snapshotId);
    const newSnapshotId = await createSnapshot(snapshotConfig.rpcUrl);
    this.snapshots.set(key, newSnapshotId);
  }

  async restoreSnapshots(snapshotConfigs: SnapshotConfig[]): Promise<void> {
    await Promise.all(
      snapshotConfigs.map((config) => this.restoreSnapshot(config)),
    );
  }

  async snapshotMultiple(snapshotConfigs: SnapshotConfig[]): Promise<void> {
    await Promise.all(
      snapshotConfigs.map((config) => this.createSnapshot(config)),
    );
  }

  reset(): void {
    this.snapshots.clear();
    this.baselineDeployConfig = this.cloneConfig(this.config.initialDeployConfig);
    this.deployConfig = this.cloneConfig(this.config.initialDeployConfig);
    this.coreConfig = undefined;
  }
}
