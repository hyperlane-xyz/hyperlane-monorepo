import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { getAbacusWorksIcasPath } from '../../scripts/agent-utils.js';
import { readJSONAtPath, writeMergedJSONAtPath } from '../utils/utils.js';

import { DeployEnvironment } from './environment.js';

export interface IcaArtifact {
  ica: Address;
  ism: Address;
}

export function persistAbacusWorksIcas(
  environment: DeployEnvironment,
  icas: ChainMap<IcaArtifact>,
) {
  // Write the updated object back to the file
  writeMergedJSONAtPath(getAbacusWorksIcasPath(environment), icas);
}

export function readAbacusWorksIcas(
  environment: DeployEnvironment,
): Promise<ChainMap<IcaArtifact>> {
  return readJSONAtPath(getAbacusWorksIcasPath(environment));
}
