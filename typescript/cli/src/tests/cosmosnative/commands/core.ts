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
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : ''
  } ${localTestRunCmdPrefix()} hyperlane core deploy \
        --registry ${registryPath} \
        --config ${coreInputPath} \
        ${privateKey ? ['--key.cosmosnative', privateKey] : ''} \
        --verbosity debug \
        ${skipConfirmationPrompts ? ['--yes'] : ''}`;
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
  return $`${localTestRunCmdPrefix()} hyperlane core check \
        --registry ${registryPath} \
        --config ${coreOutputPath} \
        --chain ${chain} \
        ${mailbox ? ['--mailbox', mailbox] : ''} \
        --verbosity debug \
        --yes`;
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
  return $`${
    hyp_key ? ['HYP_KEY=' + hyp_key] : ''
  } ${localTestRunCmdPrefix()} hyperlane core init \
        --registry ${registryPath} \
        --config ${coreOutputPath} \
        ${privateKey ? ['--key.cosmosnative', privateKey] : ''} \
        --verbosity debug \
        --yes`;
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
