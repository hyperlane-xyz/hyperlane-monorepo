import { S3Validator } from '../aws/validator.js';
import { GcpValidator } from '../gcp/validator.js';

export async function getValidatorFromStorageLocation(location: string) {
  if (location.startsWith('gs://')) {
    return GcpValidator.fromStorageLocation(location);
  }
  return S3Validator.fromStorageLocation(location);
}
