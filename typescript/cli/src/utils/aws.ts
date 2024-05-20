import { input } from '@inquirer/prompts';

export async function getAccessKeyId(skipConfirmation: boolean) {
  if (skipConfirmation) throw new Error('No AWS access key ID set.');
  else
    return await input({
      message:
        'Please enter AWS access key ID or use the AWS_ACCESS_KEY_ID environment variable.',
    });
}

export async function getSecretAccessKey(skipConfirmation: boolean) {
  if (skipConfirmation) throw new Error('No AWS secret access key set.');
  else
    return await input({
      message:
        'Please enter AWS secret access key or use the AWS_SECRET_ACCESS_KEY environment variable.',
    });
}

export async function getRegion(skipConfirmation: boolean) {
  if (skipConfirmation) throw new Error('No AWS region set.');
  else
    return await input({
      message:
        'Please enter AWS region or use the AWS_REGION environment variable.',
    });
}
