import { $, ProcessPromise } from 'zx';

import { DerivedCoreConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

import { ANVIL_KEY, REGISTRY_PATH, localTestRunCmdPrefix } from './helpers.js';

/**
 * Deploys the Hyperlane core contracts to the specified chain using the provided config.
 */
export function hyperlaneCoreDeployRaw(
  coreInputPath: string,
  privateKey?: string,
  skipConfirmationPrompts?: boolean,
  hypKey?: string,
): ProcessPromise {
  return $`${
    hypKey ? ['HYP_KEY=' + hypKey] : ''
  } ${localTestRunCmdPrefix()} hyperlane core deploy \
        --registry ${REGISTRY_PATH} \
        --config ${coreInputPath} \
        ${privateKey ? ['--key', privateKey] : ''} \
        --verbosity debug \
        ${skipConfirmationPrompts ? ['--yes'] : ''}`;
}

/**
 * Deploys the Hyperlane core contracts to the specified chain using the provided config.
 */
export async function hyperlaneCoreDeploy(
  chain: string,
  coreInputPath: string,
  privateKey?: string,
  registryPath?: string,
) {
  return $`${localTestRunCmdPrefix()} hyperlane core deploy \
        --registry ${REGISTRY_PATH} \
        --config ${coreInputPath} \
        --chain ${chain} \
        --key ${privateKey ?? ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

/**
 * Reads a Hyperlane core deployment on the specified chain using the provided config.
 */
export async function hyperlaneCoreRead(chain: string, coreOutputPath: string) {
  return $`${localTestRunCmdPrefix()} hyperlane core read \
        --registry ${REGISTRY_PATH} \
        --config ${coreOutputPath} \
        --chain ${chain} \
        --verbosity debug \
        --yes`;
}

/**
 * Verifies that a Hyperlane core deployment matches the provided config on the specified chain.
 */
export function hyperlaneCoreCheck(
  chain: string,
  coreOutputPath: string,
  mailbox?: Address,
): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane core check \
        --registry ${REGISTRY_PATH} \
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
  privateKey?: string,
  hyp_key?: string,
): ProcessPromise {
  return $`${
    hyp_key ? ['HYP_KEY=' + hyp_key] : ''
  } ${localTestRunCmdPrefix()} hyperlane core init \
        --registry ${REGISTRY_PATH} \
        --config ${coreOutputPath} \
        ${privateKey ? ['--key', privateKey] : ''} \
        --verbosity debug \
        --yes`;
}

/**
 * Updates a Hyperlane core deployment on the specified chain using the provided config.
 */
export async function hyperlaneCoreApply(
  chain: string,
  coreOutputPath: string,
) {
  return $`${localTestRunCmdPrefix()} hyperlane core apply \
        --registry ${REGISTRY_PATH} \
        --config ${coreOutputPath} \
        --chain ${chain} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

/**
 * Reads the Core deployment config and outputs it to specified output path.
 */
export async function readCoreConfig(
  chain: string,
  coreConfigPath: string,
): Promise<DerivedCoreConfig> {
  await hyperlaneCoreRead(chain, coreConfigPath);
  return readYamlOrJson(coreConfigPath);
}
