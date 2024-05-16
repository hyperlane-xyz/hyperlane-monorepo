import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { CommandContext } from '../context/types.js';
import { log, logBlue } from '../logger.js';

export async function getAddressFromBucket({
  context,
  bucket,
}: {
  context: CommandContext;
  bucket?: string;
}) {
  if (!bucket) {
    throw new Error('No S3 bucket provided.');
  }

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
    throw new Error('No AWS bucket region set.');
  }

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
    logBlue('Validator address is: ');
    log(announcement['value']['validator']);
  } else {
    throw new Error('Announcement file announcement.json not found');
  }
}
