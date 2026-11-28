import fs from 'fs';
import path from 'path';

import { assert } from '@hyperlane-xyz/utils';

import type { KeyFunderConfig } from '../config/types.js';

/**
 * Resolves the bridge state journal file path, rejecting an explicitly empty
 * KEYFUNDER_BRIDGE_STATE_FILE env var, rejecting conflicting env vs YAML state
 * paths so container volume mounts stay authoritative, and ensuring read-only
 * ConfigMap mounts (such as /config in Kubernetes) fail fast when bridges are
 * configured without a writable state volume.
 */
export function resolveBridgeStateFilePath(params: {
  config: KeyFunderConfig;
  configFile: string;
  envBridgeStateFile?: string;
}): string {
  const { config, configFile, envBridgeStateFile } = params;

  if (envBridgeStateFile !== undefined) {
    const trimmed = envBridgeStateFile.trim();
    assert(
      trimmed.length > 0,
      'KEYFUNDER_BRIDGE_STATE_FILE environment variable must not be empty when set',
    );
    if (config.bridgeStateFile !== undefined) {
      assert(
        path.resolve(config.bridgeStateFile) === path.resolve(trimmed),
        `Conflicting bridge state file configuration: KEYFUNDER_BRIDGE_STATE_FILE ("${trimmed}") does not match config.bridgeStateFile ("${config.bridgeStateFile}")`,
      );
    }
    return trimmed;
  }

  if (config.bridgeStateFile !== undefined) {
    return config.bridgeStateFile;
  }

  const defaultDir = path.dirname(path.resolve(configFile));
  const hasActiveBridge = Object.entries(config.chains).some(
    ([chain, cfg]) =>
      !(config.chainsToSkip ?? []).includes(chain) && cfg.bridge !== undefined,
  );
  if (hasActiveBridge && fs.existsSync(defaultDir)) {
    try {
      fs.accessSync(defaultDir, fs.constants.W_OK);
    } catch {
      throw new Error(
        `Config directory "${defaultDir}" is not writable; set KEYFUNDER_BRIDGE_STATE_FILE or bridgeStateFile to a writable persistent volume path`,
      );
    }
  }

  return path.join(defaultDir, '.keyfunder-bridge-state.json');
}
