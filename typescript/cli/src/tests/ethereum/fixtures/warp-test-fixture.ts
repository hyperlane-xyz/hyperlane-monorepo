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
  private baseDeployConfig: WarpRouteDeployConfig;
  private deployConfig: WarpRouteDeployConfig;
  private coreConfig?: WarpCoreConfig;
  private snapshots = new Map<string, string>();

  constructor(private readonly config: WarpTestFixtureConfig) {
    // Clone the baseline too, so later mutations of the caller's object can't
    // leak into the pristine config that restoreConfigs()/reset() clone from.
    this.baseDeployConfig = structuredClone(config.initialDeployConfig);
    this.deployConfig = structuredClone(config.initialDeployConfig);
  }

  writeConfigs(deployConfig?: WarpRouteDeployConfig): void {
    const configToWrite = deployConfig || this.deployConfig;
    writeYamlOrJson(this.config.deployConfigPath, configToWrite);

    if (this.coreConfig) {
      writeYamlOrJson(this.config.coreConfigPath, this.coreConfig);
    }
  }

  restoreDeployConfig(): void {
    writeYamlOrJson(this.config.deployConfigPath, this.deployConfig);
  }

  restoreConfigs(): void {
    // Reset to a pristine deep clone of the baseline so per-test in-place
    // mutations (owner, tokenFee, destinationGas, ...) never leak into the
    // next test.
    this.deployConfig = structuredClone(this.baseDeployConfig);
    this.writeConfigs();
  }

  updateDeployConfig(config: WarpRouteDeployConfig): void {
    this.baseDeployConfig = structuredClone(config);
    this.deployConfig = structuredClone(config);
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
    this.baseDeployConfig = structuredClone(this.config.initialDeployConfig);
    this.deployConfig = structuredClone(this.config.initialDeployConfig);
    this.coreConfig = undefined;
  }
}
