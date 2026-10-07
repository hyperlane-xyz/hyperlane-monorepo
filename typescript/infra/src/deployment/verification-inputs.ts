import { join } from 'path';

import { ChainMap, ContractVerificationInput } from '@hyperlane-xyz/sdk';
import { deepCopy, eqAddress, rootLogger } from '@hyperlane-xyz/utils';
import { pathExists, readJson } from '@hyperlane-xyz/utils/fs';

import { Modules, getModuleDirectory } from '../../scripts/agent-utils.js';
import { DeployEnvironment } from '../config/deploy-environment.js';
import { writeAndFormatJsonAtPath } from '../utils/utils.js';

export function mergeVerificationInputs(
  existingInputs: ChainMap<ContractVerificationInput[]>,
  newInputs: ChainMap<ContractVerificationInput[]>,
): ChainMap<ContractVerificationInput[]> {
  const mergedInputs: ChainMap<ContractVerificationInput[]> =
    deepCopy(existingInputs);
  for (const [chain, inputs] of Object.entries(newInputs)) {
    const chainInputs = (mergedInputs[chain] ??= []);
    for (const input of inputs) {
      if (
        chainInputs.some(
          (existing) =>
            existing.name === input.name &&
            eqAddress(existing.address, input.address) &&
            existing.constructorArguments === input.constructorArguments &&
            existing.isProxy === input.isProxy,
        )
      ) {
        continue;
      }
      chainInputs.push(input);
    }
  }
  return mergedInputs;
}

export async function writeVerificationInputsToFile(
  verificationPath: string,
  newInputs: ChainMap<ContractVerificationInput[]>,
) {
  const existingInputs = pathExists(verificationPath)
    ? readJson<ChainMap<ContractVerificationInput[]>>(verificationPath)
    : {};
  await writeAndFormatJsonAtPath(
    verificationPath,
    mergeVerificationInputs(existingInputs, newInputs),
  );
}

export async function writeVerificationInputs(
  environment: DeployEnvironment,
  module: Modules,
  newInputs: ChainMap<ContractVerificationInput[]>,
) {
  if (Object.keys(newInputs).length === 0) return;

  const verificationPath = join(
    getModuleDirectory(environment, module),
    'verification.json',
  );
  await writeVerificationInputsToFile(verificationPath, newInputs);
  rootLogger.info(
    `Wrote deployment verification inputs to ${verificationPath}`,
  );
}
