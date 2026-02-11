import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { FileLogRouter } from './fileLogger.js';

describe('FileLogRouter', () => {
  let tmpDir: string;
  let router: FileLogRouter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperlane-log-test-'));
    router = new FileLogRouter(tmpDir);
  });

  afterEach(() => {
    router.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLines(lines: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = router.createStream();
      let i = 0;
      const writeNext = () => {
        if (i >= lines.length) {
          stream.end(resolve);
          return;
        }
        const ok = stream.write(lines[i] + '\n');
        i++;
        if (ok) {
          writeNext();
        } else {
          stream.once('drain', writeNext);
        }
      };
      stream.on('error', reject);
      writeNext();
    });
  }

  function readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }

  it('creates a timestamped directory', () => {
    const logDir = router.getLogDir();
    expect(fs.existsSync(logDir)).to.be.true;
    expect(logDir.startsWith(tmpDir)).to.be.true;
    const dirname = path.basename(logDir);
    // Timestamp format: YYYY-MM-DDTHH-MM-SS-mmmZ
    expect(dirname).to.match(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes all lines to combined.log', async () => {
    const lines = [
      JSON.stringify({ msg: 'one' }),
      JSON.stringify({ msg: 'two' }),
      JSON.stringify({ msg: 'three' }),
    ];
    await writeLines(lines);

    // Allow streams to flush
    router.close();
    await new Promise((r) => setTimeout(r, 50));

    const combined = readFile(path.join(router.getLogDir(), 'combined.log'));
    expect(combined).to.include('"msg":"one"');
    expect(combined).to.include('"msg":"two"');
    expect(combined).to.include('"msg":"three"');
  });

  it('routes lines with chain field to chain file', async () => {
    await writeLines([JSON.stringify({ chain: 'ethereum', msg: 'deploy' })]);

    router.close();
    await new Promise((r) => setTimeout(r, 50));

    const chainFile = path.join(router.getLogDir(), 'ethereum.log');
    expect(fs.existsSync(chainFile)).to.be.true;
    const content = readFile(chainFile);
    expect(content).to.include('"chain":"ethereum"');
    expect(content).to.include('"msg":"deploy"');
  });

  it('lines without chain go only to combined', async () => {
    await writeLines([JSON.stringify({ msg: 'startup' })]);

    router.close();
    await new Promise((r) => setTimeout(r, 50));

    const combined = readFile(path.join(router.getLogDir(), 'combined.log'));
    expect(combined).to.include('"msg":"startup"');

    const logDir = router.getLogDir();
    const files = fs.readdirSync(logDir);
    const chainFiles = files.filter(
      (f) => f !== 'combined.log' && f.endsWith('.log'),
    );
    expect(chainFiles).to.have.length(0);
  });

  it('strips ANSI codes', async () => {
    await writeLines([JSON.stringify({ msg: '\x1b[31mred error\x1b[0m' })]);

    router.close();
    await new Promise((r) => setTimeout(r, 50));

    const combined = readFile(path.join(router.getLogDir(), 'combined.log'));
    expect(combined).to.not.include('\x1b[');
    expect(combined).to.include('red error');
  });

  it('lazy-creates chain files for multiple chains', async () => {
    await writeLines([
      JSON.stringify({ chain: 'ethereum', msg: 'eth-log' }),
      JSON.stringify({ chain: 'polygon', msg: 'poly-log' }),
    ]);

    router.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(fs.existsSync(path.join(router.getLogDir(), 'ethereum.log'))).to.be
      .true;
    expect(fs.existsSync(path.join(router.getLogDir(), 'polygon.log'))).to.be
      .true;
  });

  it('handles non-JSON lines gracefully', async () => {
    await writeLines(['plain text line', 'another plain line']);

    router.close();
    await new Promise((r) => setTimeout(r, 50));

    const combined = readFile(path.join(router.getLogDir(), 'combined.log'));
    expect(combined).to.include('plain text line');
    expect(combined).to.include('another plain line');
  });

  it('close() flushes all streams', async () => {
    await writeLines([
      JSON.stringify({ chain: 'ethereum', msg: 'test' }),
      JSON.stringify({ msg: 'global' }),
    ]);

    router.close();
    await new Promise((r) => setTimeout(r, 50));

    const combined = readFile(path.join(router.getLogDir(), 'combined.log'));
    expect(combined).to.include('"msg":"test"');
    expect(combined).to.include('"msg":"global"');

    const chainFile = readFile(path.join(router.getLogDir(), 'ethereum.log'));
    expect(chainFile).to.include('"msg":"test"');
  });
});
