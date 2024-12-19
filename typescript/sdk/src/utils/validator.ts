import { S3Validator, S3_LOCATION_PREFIX } from '../aws/validator.js';
import { GCP_LOCATION_PREFIX, GcpValidator } from '../gcp/validator.js';

export async function getValidatorFromStorageLocation(location: string) {
  if (location.startsWith(GCP_LOCATION_PREFIX)) {
    return GcpValidator.fromStorageLocation(location);
  } else if (location.startsWith(S3_LOCATION_PREFIX)) {
    return S3Validator.fromStorageLocation(location);
  } else {
    throw new Error('Invalid storage location');
  }
}

export function isValidValidatorStorageLocation(location: string) {
  return (
    location?.startsWith(GCP_LOCATION_PREFIX) ||
    location?.startsWith(S3_LOCATION_PREFIX)
  );
}
