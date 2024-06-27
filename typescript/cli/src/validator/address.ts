import { GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { input } from '@inquirer/prompts';
// @ts-ignore
import asn1 from 'asn1.js';
import { ethers } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { log, logBlue } from '../logger.js';

export async function getValidatorAddress({
  context,
  accessKey,
  secretKey,
  region,
  bucket,
  keyId,
}: {
  context: CommandContext;
  accessKey?: string;
  secretKey?: string;
  region?: string;
  bucket?: string;
  keyId?: string;
}): Promise<void> {
  if (!bucket && !keyId) {
    throw new Error('Must provide either an S3 bucket or a KMS Key ID.');
  }

  // Query user for AWS parameters if not passed in or stored as .env variables
  accessKey ||= await getAccessKeyId(context.skipConfirmation);
  secretKey ||= await getSecretAccessKey(context.skipConfirmation);
  region ||= await getRegion(context.skipConfirmation);

  assert(accessKey, 'No access key ID set.');
  assert(secretKey, 'No secret access key set.');
  assert(region, 'No AWS region set.');

  let validatorAddress: string;
  if (bucket) {
    validatorAddress = await getAddressFromBucket(
      bucket,
      accessKey,
      secretKey,
      region,
    );
  } else {
    validatorAddress = await getAddressFromKey(
      keyId!,
      accessKey,
      secretKey,
      region,
    );
  }

  logBlue('Validator address is: ');
  log(validatorAddress);
}

/**
 * Displays validator key address from
 * validator announcement S3 bucket.
 */
async function getAddressFromBucket(
  bucket: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
): Promise<string> {
  const s3Client = new S3Client({
    region: region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const { Body } = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: 'announcement.json',
    }),
  );

  if (Body) {
    const announcement = JSON.parse(await Body?.transformToString());
    return announcement['value']['validator'];
  } else {
    throw new Error('Announcement file announcement.json not found in bucket');
  }
}

/**
 * Logs validator key address using AWS KMS key ID.
 * Taken from github.com/tkporter/get-aws-kms-address/
 */
async function getAddressFromKey(
  keyId: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
): Promise<string> {
  const client = new KMSClient({
    region: region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const publicKeyResponse = await client.send(
    new GetPublicKeyCommand({ KeyId: keyId }),
  );

  return getEthereumAddress(Buffer.from(publicKeyResponse.PublicKey!));
}

const EcdsaPubKey = asn1.define('EcdsaPubKey', function (this: any) {
  this.seq().obj(
    this.key('algo').seq().obj(this.key('a').objid(), this.key('b').objid()),
    this.key('pubKey').bitstr(),
  );
});

function getEthereumAddress(publicKey: Buffer): string {
  // The public key is ASN1 encoded in a format according to
  // https://tools.ietf.org/html/rfc5480#section-2
  const res = EcdsaPubKey.decode(publicKey, 'der');
  let pubKeyBuffer: Buffer = res.pubKey.data;

  // The public key starts with a 0x04 prefix that needs to be removed
  // more info: https://www.oreilly.com/library/view/mastering-ethereum/9781491971932/ch04.html
  pubKeyBuffer = pubKeyBuffer.slice(1, pubKeyBuffer.length);

  const address = ethers.utils.keccak256(pubKeyBuffer); // keccak256 hash of publicKey
  return `0x${address.slice(-40)}`; // take last 20 bytes as ethereum address
}

async function getAccessKeyId(skipConfirmation: boolean): Promise<string> {
  if (skipConfirmation) throw new Error('No AWS access key ID set.');
  else
    return input({
      message:
        'Please enter AWS access key ID or use the AWS_ACCESS_KEY_ID environment variable.',
    });
}

async function getSecretAccessKey(skipConfirmation: boolean): Promise<string> {
  if (skipConfirmation) throw new Error('No AWS secret access key set.');
  else
    return input({
      message:
        'Please enter AWS secret access key or use the AWS_SECRET_ACCESS_KEY environment variable.',
    });
}

async function getRegion(skipConfirmation: boolean): Promise<string> {
  if (skipConfirmation) throw new Error('No AWS region set.');
  else
    return input({
      message:
        'Please enter AWS region or use the AWS_REGION environment variable.',
    });
}
