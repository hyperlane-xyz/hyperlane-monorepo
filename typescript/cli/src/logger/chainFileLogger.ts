import fs from 'fs';
import path from 'path';
import { Transform, type Writable } from 'stream';

// eslint-disable-next-line no-control-regex -- intentional: matching ANSI escape sequences
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export class ChainFileLogger {
  private combinedStream: fs.WriteStream;
  private chainStreams: Map<string, fs.WriteStream> = new Map();
  private logDir: string;

  constructor(baseDir: string) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logDir = path.join(baseDir, timestamp);
    fs.mkdirSync(this.logDir, { recursive: true });
    this.combinedStream = fs.createWriteStream(
      path.join(this.logDir, 'combined.log'),
      { flags: 'a' }, // append
    );
  }

  getLogDir(): string {
    return this.logDir;
  }

  createStream(): Writable {
    return new Transform({
      transform: (chunk, _encoding, callback) => {
        const line = chunk.toString();
        // Strip ANSI escape codes (e.g. chalk colors) so log files contain clean, parseable JSON
        const stripped = line.replace(ANSI_REGEX, '');

        this.combinedStream.write(stripped);

        try {
          const parsed = JSON.parse(stripped);
          if (parsed.chain && typeof parsed.chain === 'string') {
            this.getOrCreateChainStream(parsed.chain).write(stripped);
          }
        } catch {
          // Non-JSON line — only goes to combined.log
        }

        callback();
      },
    });
  }

  private getOrCreateChainStream(chain: string): fs.WriteStream {
    let stream = this.chainStreams.get(chain);
    if (!stream) {
      stream = fs.createWriteStream(path.join(this.logDir, `${chain}.log`), {
        flags: 'a',
      });
      this.chainStreams.set(chain, stream);
    }
    return stream;
  }

  async close(): Promise<void> {
    const endStream = (stream: fs.WriteStream) =>
      new Promise<void>((resolve) => stream.end(resolve));

    await Promise.all([
      endStream(this.combinedStream),
      ...[...this.chainStreams.values()].map(endStream),
    ]);
  }
}
