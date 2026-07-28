import * as mainnetSdk from '@provablehq/sdk/mainnet.js';

import * as helper from './helper.js';

export function getAddressFromProgramId(programId: string): string {
  return helper.getAddressFromProgramId(mainnetSdk, programId);
}

export function toAleoAddress(programId: string): string {
  return helper.toAleoAddress(mainnetSdk, programId);
}

export function toKeyId(
  programId: string,
  mappingName: string,
  key: string,
): string {
  return helper.toKeyId(mainnetSdk, programId, mappingName, key);
}
