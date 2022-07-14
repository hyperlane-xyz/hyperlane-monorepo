import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3';
import yargs from 'yargs';

interface Checkpoint {
  checkpoint: {
    outbox_domain: number;
    root: string;
    index: number;
  };
  signature: {
    r: string;
    s: string;
    v: number;
  };
}

function isCheckpoint(obj: unknown): obj is Checkpoint {
  const c = obj as Partial<Checkpoint>;
  return (
    typeof obj == 'object' &&
    obj != null &&
    'checkpoint' in obj &&
    Number.isSafeInteger(c.checkpoint?.outbox_domain) &&
    Number.isSafeInteger(c.checkpoint?.index) &&
    isValidHashStr(c.checkpoint?.root ?? '') &&
    'signature' in obj &&
    isValidHashStr(c.signature?.r ?? '') &&
    isValidHashStr(c.signature?.s ?? '') &&
    Number.isSafeInteger(c.signature?.v)
  );
}

function isValidHashStr(s: string): boolean {
  return !!s.match(/^0x[0-9a-f]{64}$/im);
}

function getArgs() {
  return yargs(process.argv.slice(2))
    .alias('a', 'address ')
    .describe('a', 'address of the validator to inspect')
    .demandOption('a')
    .string('a')
    .alias('p', 'prospective')
    .describe('p', 'S3 bucket of the prospective validator')
    .demandOption('p')
    .string('p')
    .alias('c', 'control')
    .describe('c', 'S3 bucket of the the known (control) validator')
    .demandOption('c')
    .string('c').argv;
}

class S3Wrapper {
  private readonly client: S3Client;

  constructor(cfg: S3ClientConfig) {
    this.client = new S3Client({});
  }

  async getS3Obj<T = unknown>(bucket: string, key: string): Promise<T> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    if (!response.Body) {
      throw new Error('No data received');
    }
    const bodyStream: NodeJS.ReadableStream =
      response.Body instanceof Blob
        ? response.Body.stream()
        : (response.Body as NodeJS.ReadableStream);

    const body: string = await streamToString(bodyStream);
    return JSON.parse(body);
  }

  async getLastModTime(bucket: string, key: string): Promise<Date> {
    const request = await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        MaxKeys: 1,
        KeyMarker: key,
      }),
    );

    const latestIdx = request.Versions!.findIndex(
      (v) => v.IsLatest && v.Key == key,
    );
    const latest = request.Versions![latestIdx]!;
    return latest.LastModified!;
  }
}

async function main() {
  const {
    a: validatorAddress,
    p: prospectiveBucket,
    c: controlBucket,
  } = await getArgs();

  const client = new S3Wrapper({});

  const [cLatestCheckpoint, pLastCheckpoint] = await Promise.all([
    client
      .getS3Obj<number>(controlBucket, 'checkpoint_latest_index.json')
      .catch((err) => {
        console.error(
          "Failed to get control validator's latest checkpoint.",
          err,
        );
        process.exit(1);
      }),
    client
      .getS3Obj<number>(prospectiveBucket, 'checkpoint_latest_index.json')
      .catch((err) => {
        console.error(
          "Failed to get prospective validator's latest checkpoint.",
          err,
        );
        process.exit(1);
      }),
  ]);

  console.assert(
    Number.isSafeInteger(cLatestCheckpoint),
    'Expected latest control checkpoint to be an integer',
  );
  console.assert(
    Number.isSafeInteger(pLastCheckpoint),
    'Expected latest prospective checkpoint to be an integer',
  );

  console.log(`Latest Index`);
  console.log(`C: ${cLatestCheckpoint}`);
  console.log(`P: ${pLastCheckpoint}`);

  let extraCheckpoints = [];
  const missingCheckpoints = [];
  let invalidCheckpoints = [];
  const modTimeDeltasMs = [];
  const fullyCorrectCheckpoints = [];
  let missingInARow = 0;
  for (let i = Math.max(cLatestCheckpoint, pLastCheckpoint); i >= 0; --i) {
    if (missingInARow == 10) {
      missingCheckpoints.length -= 10;
      invalidCheckpoints = invalidCheckpoints.filter((j) => j < i - 10);
      extraCheckpoints = extraCheckpoints.filter((j) => j < i - 10);
      break;
    }

    const key = `checkpoint_{${i}}.json`;

    let c: Checkpoint | null;
    try {
      const t = await client.getS3Obj(controlBucket, key);
      if (isCheckpoint(t)) {
        if (t.checkpoint.index != i) {
          console.error(`${i}: Control index is invalid`, t);
          process.exit(1);
        }
        c = t;
      } else {
        console.error(`${i}: Invalid control checkpoint`, t);
        process.exit(1);
      }
    } catch (err) {
      c = null;
    }

    let p: Checkpoint;
    try {
      const t = await client.getS3Obj(prospectiveBucket, key);
      if (isCheckpoint(t)) {
        p = t;
      } else {
        console.warn(`${i}: Invalid prospective checkpoint`, t);
        invalidCheckpoints.push(i);
        continue;
      }
      if (!c) {
        extraCheckpoints.push(i);
      }
      missingInARow = 0;
    } catch (err) {
      missingCheckpoints.push(i);
      missingInARow++;
      continue;
    }

    console.assert(
      p.checkpoint.index != i,
      `${i}: checkpoint indexes do not match`,
    );

    // TODO: verify signature

    if (!c) {
      continue;
    }

    // compare against the control
    console.assert(
      c.checkpoint.outbox_domain == p.checkpoint.outbox_domain,
      `${i}: outbox_domains do not match`,
    );
    console.assert(
      c.checkpoint.root == p.checkpoint.root,
      `${i}: checkpoint roots do not match`,
    );

    try {
      const [cLastMod, pLastMod] = await Promise.all([
        client.getLastModTime(controlBucket, key),
        client.getLastModTime(prospectiveBucket, key),
      ]);
      const diffMs = cLastMod.valueOf() - pLastMod.valueOf();
      if (Math.abs(diffMs) > 10000) {
        console.log(`${i}: Modification times differ by ${diffMs / 1000}s`);
      }
      modTimeDeltasMs.push(diffMs);
    } catch (err) {
      // this is probably a connection error since we already know they should exist
      console.error(`${i}: Error validating last modified times`, err);
    }

    fullyCorrectCheckpoints.push(i);
  }

  if (fullyCorrectCheckpoints.length)
    console.log(
      `Fully correct checkpoints ${fullyCorrectCheckpoints.length}: ${fullyCorrectCheckpoints}`,
    );
  if (extraCheckpoints.length)
    console.log(
      `Extra checkpoints ${extraCheckpoints.length}: ${extraCheckpoints}`,
    );
  if (missingCheckpoints.length)
    console.log(
      `Missing checkpoints ${missingCheckpoints.length}: ${missingCheckpoints}`,
    );
  if (invalidCheckpoints.length)
    console.log(
      `Invalid checkpoints ${invalidCheckpoints.length}: ${invalidCheckpoints}`,
    );

  console.log(`Time deltas`);
  console.log(`Median: ${median(modTimeDeltasMs) / 1000}s`);
  console.log(`Mean:   ${mean(modTimeDeltasMs) / 1000}s`);
  console.log(`Stdev:  ${stdDev(modTimeDeltasMs) / 1000}s`);
}

function median(a: number[]): number {
  a = [...a]; // clone
  a.sort();
  if (a.length <= 0) {
    return 0;
  } else if (a.length % 2 == 0) {
    return (a[a.length / 2] + a[a.length / 2 - 1]) / 2;
  } else {
    return a[(a.length - 1) / 2];
  }
}

function mean(a: number[]): number {
  return a.reduce((acc, i) => acc + i, 0) / a.length;
}

function stdDev(a: number[]): number {
  return Math.sqrt(
    a.map((i) => i * i).reduce((acc, i) => acc + i, 0) / a.length,
  );
}

function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    stream
      .setEncoding('utf8')
      .on('data', (chunk) => chunks.push(chunk))
      .on('error', (err) => reject(err))
      .on('end', () => resolve(String.prototype.concat(...chunks)));
  });
}

main().then(console.log).catch(console.error);
