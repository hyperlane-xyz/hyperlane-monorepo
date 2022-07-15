import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as Process from 'process';
import yargs from 'yargs';

const MAX_MISSING_CHECKPOINTS = 10;

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

function isLatestCheckpoint(latest: unknown): latest is number {
  if (typeof latest == 'number' && Number.isSafeInteger(latest) && latest > 0) {
    return true;
  } else {
    console.log(
      'Expected latest checkpoint to be a valid integer greater than 0',
      latest,
    );
    return false;
  }
}

function isValidHashStr(s: string): boolean {
  return !!s.match(/^0x[0-9a-f]{1,64}$/im);
}

class S3Wrapper {
  private readonly client: S3Client;
  readonly region: string;
  readonly bucket: string;

  constructor(bucketUrl: string) {
    const match = bucketUrl.match(
      /^(?:https?:\/\/)?(.*)\.s3\.(.*)\.amazonaws.com\/?$/,
    );
    if (!match) throw new Error('Could not parse bucket url');
    this.bucket = match[1];
    this.region = match[2];
    this.client = new S3Client({ region: this.region });
  }

  async getS3Obj<T = unknown>(
    key: string,
  ): Promise<{ obj: T; modified: Date }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    if (!response.Body) {
      throw new Error('No data received');
    }
    const bodyStream: NodeJS.ReadableStream =
      'stream' in response.Body
        ? response.Body.stream()
        : (response.Body as NodeJS.ReadableStream);

    const body: string = await streamToString(bodyStream);
    return {
      obj: JSON.parse(body),
      modified: response.LastModified!,
    };
  }
}

class Validator {
  private readonly controlS3BucketClient: S3Wrapper;
  private readonly prospectiveS3BucketClient: S3Wrapper;

  // accumulators for stats
  private extraCheckpoints!: number[];
  private missingCheckpoints!: number[];
  private invalidCheckpoints!: number[];
  private modTimeDeltasS!: number[];
  private fullyCorrectCheckpoints!: number[];
  private missingInARow!: number;
  private lastNonMissingCheckpointIndex!: number;

  constructor(
    public readonly validatorAddress: string,
    public readonly controlS3BucketAddress: string,
    public readonly prospectiveS3BucketAddress: string,
  ) {
    this.controlS3BucketClient = new S3Wrapper(this.controlS3BucketAddress);
    this.prospectiveS3BucketClient = new S3Wrapper(
      this.prospectiveS3BucketAddress,
    );
  }

  initStatsState() {
    this.extraCheckpoints = [];
    this.missingCheckpoints = [];
    this.invalidCheckpoints = [];
    this.modTimeDeltasS = [];
    this.fullyCorrectCheckpoints = [];
    this.missingInARow = 0;
    this.lastNonMissingCheckpointIndex = Infinity;
  }

  /**
   * Validate that the control and prospective validators are in agreement. Will throw an error on
   * any critical failures and will log stats to the console as it goes.
   *
   * If we want to make this callable from outside the script later I would suggest making this
   * return a stats object or something.
   */
  async validate(): Promise<void> {
    this.initStatsState();

    const { controlLatestCheckpoint, prospectiveLastCheckpoint } =
      await this.getLatestCheckpoints();

    for (
      let checkpointIndex = Math.max(
        controlLatestCheckpoint,
        prospectiveLastCheckpoint,
      );
      checkpointIndex >= 0;
      --checkpointIndex
    ) {
      if (this.missingInARow == MAX_MISSING_CHECKPOINTS) {
        this.missingCheckpoints.length -= MAX_MISSING_CHECKPOINTS;
        this.invalidCheckpoints = this.invalidCheckpoints.filter(
          (j) => j < this.lastNonMissingCheckpointIndex,
        );
        this.extraCheckpoints = this.extraCheckpoints.filter(
          (j) => j < this.lastNonMissingCheckpointIndex,
        );
        break;
      }

      await this.validateCheckpointIndex(checkpointIndex);
    }

    console.log(
      `Fully correct checkpoints (${this.fullyCorrectCheckpoints.length}): ${this.fullyCorrectCheckpoints}\n`,
    );
    if (this.extraCheckpoints.length)
      console.log(
        `Extra checkpoints (${this.extraCheckpoints.length}): ${this.extraCheckpoints}\n`,
      );
    if (this.missingCheckpoints.length)
      console.log(
        `Missing checkpoints (${this.missingCheckpoints.length}): ${this.missingCheckpoints}\n`,
      );
    if (this.invalidCheckpoints.length)
      console.log(
        `Invalid checkpoints (${this.invalidCheckpoints.length}): ${this.invalidCheckpoints}\n`,
      );

    if (this.modTimeDeltasS.length > 1) {
      // Drop the time of the first one since it is probably way off
      this.modTimeDeltasS.length--;
      console.log(
        `Time deltas (∆ < 0 -> prospective came earlier than the control)`,
      );
      console.log(this.modTimeDeltasS);
      console.log(`Median: ${median(this.modTimeDeltasS)}s`);
      console.log(`Mean:   ${mean(this.modTimeDeltasS)}s`);
      console.log(`Stdev:  ${stdDev(this.modTimeDeltasS)}s`);
    }
  }

  private async validateCheckpointIndex(
    checkpointIndex: number,
  ): Promise<void> {
    const { control, controlLastMod } = (await this.getControlCheckpoint(
      checkpointIndex,
    )) ?? { control: null, controlLastMod: null };

    const getProspectiveCheckpointResult = await this.getProspectiveCheckpoint(
      checkpointIndex,
      !!control,
    );
    if (!getProspectiveCheckpointResult) return;
    const { prospective, prospectiveLastMod } = getProspectiveCheckpointResult;

    console.assert(
      prospective.checkpoint.index == checkpointIndex,
      `${checkpointIndex}: checkpoint indexes do not match`,
    );

    // TODO: verify signature

    if (!control) {
      return;
    }

    // compare against the control
    console.assert(
      control.checkpoint.outbox_domain == prospective.checkpoint.outbox_domain,
      `${checkpointIndex}: outbox_domains do not match`,
    );
    console.assert(
      control.checkpoint.root == prospective.checkpoint.root,
      `${checkpointIndex}: checkpoint roots do not match`,
    );

    const diffS =
      (prospectiveLastMod.valueOf() - controlLastMod!.valueOf()) / 1000;
    if (Math.abs(diffS) > 10) {
      console.log(`${checkpointIndex}: Modification times differ by ${diffS}s`);
    }
    this.modTimeDeltasS.push(diffS);
    this.fullyCorrectCheckpoints.push(checkpointIndex);
  }

  private async getLatestCheckpoints(): Promise<{
    controlLatestCheckpoint: number;
    prospectiveLastCheckpoint: number;
  }> {
    const [
      { obj: controlLatestCheckpoint },
      { obj: prospectiveLastCheckpoint },
    ] = await Promise.all([
      this.controlS3BucketClient
        .getS3Obj<number>('checkpoint_latest_index.json')
        .catch((err) => {
          console.error(
            "Failed to get control validator's latest checkpoint.",
            err,
          );
          process.exit(1);
        }),
      this.prospectiveS3BucketClient
        .getS3Obj<number>('checkpoint_latest_index.json')
        .catch((err) => {
          console.error(
            "Failed to get prospective validator's latest checkpoint.",
            err,
          );
          process.exit(1);
        }),
    ]);

    if (
      !isLatestCheckpoint(controlLatestCheckpoint) ||
      !isLatestCheckpoint(prospectiveLastCheckpoint)
    )
      throw new Error('Invalid latest checkpoint data');

    console.log(`Latest Index`);
    console.log(`control: ${controlLatestCheckpoint}`);
    console.log(`prospective: ${prospectiveLastCheckpoint}\n`);
    return { controlLatestCheckpoint, prospectiveLastCheckpoint };
  }

  private async getControlCheckpoint(
    checkpointIndex: number,
  ): Promise<{ control: Checkpoint; controlLastMod: Date } | null> {
    let control: Checkpoint, controlLastMod: Date, unrecoverableError;
    try {
      const t = await this.controlS3BucketClient.getS3Obj(
        this.checkpointKey(checkpointIndex),
      );
      if (isCheckpoint(t.obj)) {
        if (t.obj.checkpoint.index != checkpointIndex) {
          console.log(`${checkpointIndex}: Control index is invalid`, t);
          process.exit(1);
        }
        [control, controlLastMod] = [t.obj, t.modified];
      } else {
        console.log(`${checkpointIndex}: Invalid control checkpoint`, t);
        unrecoverableError = new Error('Invalid control checkpoint.');
      }
    } catch (err) {
      return null;
    }
    if (unrecoverableError) throw unrecoverableError;
    return { control: control!, controlLastMod: controlLastMod! };
  }

  private async getProspectiveCheckpoint(
    checkpointIndex: number,
    controlFoundForIndex: boolean,
  ): Promise<{ prospective: Checkpoint; prospectiveLastMod: Date } | null> {
    let prospective: Checkpoint, prospectiveLastMod: Date;
    try {
      const t = await this.prospectiveS3BucketClient.getS3Obj(
        this.checkpointKey(checkpointIndex),
      );
      if (isCheckpoint(t.obj)) {
        [prospective, prospectiveLastMod] = [t.obj, t.modified];
        this.lastNonMissingCheckpointIndex = checkpointIndex;
      } else {
        console.log(
          `${checkpointIndex}: Invalid prospective checkpoint`,
          t.obj,
        );
        this.invalidCheckpoints.push(checkpointIndex);
        return null;
      }
      if (!controlFoundForIndex) {
        this.extraCheckpoints.push(checkpointIndex);
      }
      this.missingInARow = 0;
    } catch (err) {
      if (controlFoundForIndex) {
        this.missingCheckpoints.push(checkpointIndex);
        this.missingInARow++;
      }
      return null;
    }

    return {
      prospective: prospective!,
      prospectiveLastMod: prospectiveLastMod!,
    };
  }

  private checkpointKey(checkpointIndex: number): string {
    return `checkpoint_${checkpointIndex}.json`;
  }
}

////
// A few static utilities
////
function median(a: number[]): number {
  a = [...a]; // clone
  a.sort((a, b) => a - b);
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

////
// Bootstrapper
////
function getArgs() {
  return yargs(process.argv.slice(2))
    .alias('a', 'address')
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

async function main() {
  const {
    a: validatorAddress,
    p: prospectiveBucket,
    c: controlBucket,
  } = await getArgs();

  const validator = new Validator(
    validatorAddress,
    prospectiveBucket,
    controlBucket,
  );

  try {
    await validator.validate();
  } catch (err) {
    console.error(err);
    Process.exit(1);
  }
}

main().catch(console.error);
