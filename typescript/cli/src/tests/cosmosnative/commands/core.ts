import { $, ProcessPromise } from 'zx';

import { DerivedCoreConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../../utils/files.js';

import { localTestRunCmdPrefix } from './helpers.js';

/**
 * Deploys the Hyperlane core contracts to the specified chain using the provided config.
 */
export function hyperlaneCoreDeployRaw(
  coreInputPath: string,
  registryPath: string,
  privateKey?: string,
  skipConfirmationPrompts?: boolean,
  hypKey?: string,
): ProcessPromise {
  const flags = [
    '--registry',
    registryPath,
    '--config',
    coreInputPath,
    '--verbosity',
    'debug',
  ];

  if (privateKey) {
    flags.push('--key.cosmosnative', privateKey);
  }

  if (skipConfirmationPrompts) {
    flags.push('--yes');
  }

  return $`${[
    'HYP_KEY_COSMOSNATIVE=' + hypKey,
  ]} ${localTestRunCmdPrefix()} hyperlane core deploy ${flags}`;
}

/**
 * Deploys the Hyperlane core contracts to the specified chain using the provided config.
 */
export async function hyperlaneCoreDeploy(
  registryPath: string,
  privateKey: string,
  chain: string,
  coreInputPath: string,
) {
  return $`${localTestRunCmdPrefix()} hyperlane core deploy \
        --registry ${registryPath} \
        --config ${coreInputPath} \
        --chain ${chain} \
        --key.cosmosnative ${privateKey} \
        --verbosity debug \
        --yes`;
}

/**
 * Reads a Hyperlane core deployment on the specified chain using the provided config.
 */
export async function hyperlaneCoreRead(
  registryPath: string,
  chain: string,
  coreOutputPath: string,
) {
  return $`${localTestRunCmdPrefix()} hyperlane core read \
        --registry ${registryPath} \
        --config ${coreOutputPath} \
        --chain ${chain} \
        --verbosity debug \
        --yes`;
}

/**
 * Verifies that a Hyperlane core deployment matches the provided config on the specified chain.
 */
export function hyperlaneCoreCheck(
  registryPath: string,
  chain: string,
  coreOutputPath: string,
  mailbox?: Address,
): ProcessPromise {
  const flags = [
    '--registry',
    registryPath,
    '--config',
    coreOutputPath,
    '--chain',
    chain,
    '--verbosity',
    'debug',
    '--yes',
  ];

  if (mailbox) {
    flags.push('--mailbox', mailbox);
  }

  return $`${localTestRunCmdPrefix()} hyperlane core check ${flags}`;
}

/**
 * Creates a Hyperlane core deployment config
 */
export function hyperlaneCoreInit(
  coreOutputPath: string,
  registryPath: string,
  privateKey?: string,
  hyp_key?: string,
): ProcessPromise {
  const flags = [
    '--registry',
    registryPath,
    '--config',
    coreOutputPath,
    '--verbosity',
    'debug',
    '--yes',
  ];

  if (privateKey) {
    flags.push('--key.cosmosnative', privateKey);
  }

  return $`${[
    'HYP_KEY_COSMOSNATIVE=' + hyp_key,
  ]} ${localTestRunCmdPrefix()} hyperlane core init ${flags}`;
}

/**
 * Updates a Hyperlane core deployment on the specified chain using the provided config.
 */
export async function hyperlaneCoreApply(
  registryPath: string,
  privateKey: string,
  chain: string,
  coreOutputPath: string,
) {
  return $`${localTestRunCmdPrefix()} hyperlane core apply \
        --registry ${registryPath} \
        --config ${coreOutputPath} \
        --chain ${chain} \
        --key.cosmosnative ${privateKey} \
        --verbosity debug \
        --yes`;
}

/**
 * Reads the Core deployment config and outputs it to specified output path.
 */
export async function readCoreConfig(
  registryPath: string,
  chain: string,
  coreConfigPath: string,
): Promise<DerivedCoreConfig> {
  await hyperlaneCoreRead(registryPath, chain, coreConfigPath);
  return readYamlOrJson(coreConfigPath);
}
