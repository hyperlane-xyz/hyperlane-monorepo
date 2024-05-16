import { GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
// @ts-ignore
import asn1 from 'asn1.js';
import { ethers } from 'ethers';

import { CommandContext } from '../context/types.js';
import { log, logBlue } from '../logger.js';

export async function getValidatorAddress({
  context,
  bucket,
  keyId,
}: {
  context: CommandContext;
  bucket?: string;
  keyId: string;
}) {
  if (!bucket && !keyId) {
    throw new Error('Must provide either an S3 bucket or a KMS Key ID.');
  }

  // User must have below env variables configured beforehand
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION;

  if (!accessKeyId) {
    throw new Error('No access key ID set.');
  }

  if (!secretAccessKey) {
    throw new Error('No secret access key set.');
  }

  if (!region) {
    throw new Error('No AWS region set.');
  }

  let validatorAddress;
  if (bucket) {
    validatorAddress = await getAddressFromBucket(
      bucket,
      accessKeyId,
      secretAccessKey,
      region,
    );
  } else {
    validatorAddress = await getAddressFromKey(
      keyId,
      accessKeyId,
      secretAccessKey,
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
) {
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
) {
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
  const EthAddr = `0x${address.slice(-40)}`; // take last 20 bytes as ethereum adress
  return EthAddr;
}
