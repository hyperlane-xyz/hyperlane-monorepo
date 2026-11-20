// Records raw HTTP exchanges against a running TS scraper proxy so the Zig
// server can replay the same bytes and assert identical responses.
// Usage (TS server on PORT, e.g. `PORT=28391 tsx src/main.ts`):
//   node zig/scraper-proxy/src/http/testdata/gen-http-corpus.mjs 28391 > zig/scraper-proxy/src/http/testdata/http-corpus.json
// Only responses decided by Node http / Fastify / @fastify/cors / ws before
// GraphQL or live-stream logic runs belong here.
import { connect } from 'node:net';

import { appCases, coreCases } from './cases.mjs';

const port = Number(process.argv[2]);

function exchange(chunks) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const parts = [];
    let quiet;
    let ended = false;
    const finish = (marker) => {
      if (ended) return;
      ended = true;
      clearTimeout(quiet);
      clearTimeout(hard);
      socket.destroy();
      resolve(Buffer.concat(parts).toString('latin1') + marker);
    };
    const arm = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => finish('<OPEN>'), 400);
    };
    const hard = setTimeout(() => finish('<OPEN>'), 5_000);
    socket.on('data', (chunk) => {
      parts.push(chunk);
      arm();
    });
    socket.on('end', () => finish('<EOF>'));
    socket.on('error', () => finish('<RESET>'));
    socket.on('close', () => finish('<EOF>'));
    socket.once('connect', async () => {
      for (const chunk of chunks) {
        socket.write(Buffer.from(chunk, 'latin1'));
        await new Promise((r) => setTimeout(r, 50));
      }
      arm();
    });
  });
}

const normalize = (text) =>
  text.replace(/\r\nDate: [^\r]*/g, '\r\nDate: <DATE>');
const results = [];
for (const [name, chunks, mode = 'full'] of process.argv[3] === 'app'
  ? appCases
  : coreCases) {
  results.push({
    name,
    chunks,
    mode,
    response: normalize(await exchange(chunks)),
  });
}
process.stdout.write(`${JSON.stringify({ cases: results }, null, 1)}\n`);
