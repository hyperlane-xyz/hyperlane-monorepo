import { IAMClient } from '@aws-sdk/client-iam';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';

const iamClients = new Map<string, IAMClient>();
const kmsClients = new Map<string, KMSClient>();
const s3Clients = new Map<string, S3Client>();

export function getAwsIamClient(region: string): IAMClient {
  let client = iamClients.get(region);
  if (!client) {
    client = new IAMClient({ region });
    iamClients.set(region, client);
  }
  return client;
}

export function getAwsKmsClient(region: string): KMSClient {
  let client = kmsClients.get(region);
  if (!client) {
    client = new KMSClient({ region });
    kmsClients.set(region, client);
  }
  return client;
}

export function getAwsS3Client(region: string): S3Client {
  let client = s3Clients.get(region);
  if (!client) {
    client = new S3Client({ region });
    s3Clients.set(region, client);
  }
  return client;
}
