import fs from 'fs';
import path from 'path';
import { Transform, type Writable } from 'stream';

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export class FileLogRouter {
  private combinedStream: fs.WriteStream;
  private chainStreams: Map<string, fs.WriteStream> = new Map();
  private logDir: string;

  constructor(baseDir: string) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logDir = path.join(baseDir, timestamp);
    fs.mkdirSync(this.logDir, { recursive: true });
    this.combinedStream = fs.createWriteStream(
      path.join(this.logDir, 'combined.log'),
      { flags: 'a' },
    );
  }

  getLogDir(): string {
    return this.logDir;
  }

  createStream(): Writable {
    return new Transform({
      transform: (chunk, _encoding, callback) => {
        const line = chunk.toString();
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

  close(): void {
    this.combinedStream.end();
    for (const stream of this.chainStreams.values()) {
      stream.end();
    }
  }
}
