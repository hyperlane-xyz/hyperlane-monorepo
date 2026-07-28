import * as mainnetSdk from '@provablehq/sdk/mainnet.js';

import {
  getAddressFromProgramIdWithSdk,
  toAleoAddressWithSdk,
  toKeyIdWithSdk,
} from './helper.js';

export function getAddressFromProgramId(programId: string): string {
  return getAddressFromProgramIdWithSdk(mainnetSdk, programId);
}

export function toAleoAddress(programId: string): string {
  return toAleoAddressWithSdk(mainnetSdk, programId);
}

export function toKeyId(
  programId: string,
  mappingName: string,
  key: string,
): string {
  return toKeyIdWithSdk(mainnetSdk, programId, mappingName, key);
}
