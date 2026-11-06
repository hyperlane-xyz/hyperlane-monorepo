// Disposable HTTP/2 fixture. No external packages, keys, or chain requests.
import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
const sdk = JSON.parse(
  readFileSync(new URL('../fixtures/sdk.json', import.meta.url), 'utf8'),
);
const sdkMethods = new Map([
  [
    '/cosmos.base.tendermint.v1beta1.Service/GetLatestValidatorSet',
    ['', sdk.latest_response],
  ],
  [
    '/cosmwasm.wasm.v1.Query/SmartContractState',
    [sdk.smart_request, sdk.smart_response],
  ],
  [
    '/hyperlane.core.v1.Query/Mailbox',
    [sdk.mailbox_request, sdk.mailbox_response],
  ],
  [
    '/hyperlane.core.post_dispatch.v1.Query/MerkleTreeHook',
    [sdk.tree_request, sdk.tree_response],
  ],
  [
    '/hyperlane.core.interchain_security.v1.Query/Ism',
    [sdk.ism_request, sdk.ism_response],
  ],
]);
const server = http2.createServer();
const fallbackCounts = Object.create(null);
server.on('stream', (stream, headers) => {
  stream.on('error', () => {});
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('end', () => {
    let path = headers[':path'].split('?')[0].replace(/^\/prefix/, '');
    if (path === '/fallback/stats') {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify(fallbackCounts));
      return;
    }
    const fallback = path.match(/^\/fallback\/(bad|fast)(\/.*)$/);
    const role = fallback?.[1];
    if (fallback) {
      path = fallback[2];
      fallbackCounts[`${role}:${path}`] =
        (fallbackCounts[`${role}:${path}`] ?? 0) + 1;
    }
    if (path === '/test.Service/Deadline') return;
    if (
      headers[':method'] !== 'POST' ||
      headers['content-type'] !== 'application/grpc+proto'
    ) {
      stream.respond({ ':status': 400 });
      stream.end();
      return;
    }
    const request = Buffer.concat(chunks);
    let response = Buffer.from(request);
    let grpcStatus =
      role === 'bad' ? '14' : path === '/test.Service/Failure' ? '7' : '0';
    const sdkMethod = sdkMethods.get(path);
    if (sdkMethod) {
      if (
        request.length < 5 ||
        request[0] !== 0 ||
        request.readUInt32BE(1) !== request.length - 5 ||
        request.subarray(5).toString('hex') !== sdkMethod[0]
      ) {
        grpcStatus = '3';
      }
      const protobuf = Buffer.from(sdkMethod[1], 'hex');
      response = Buffer.alloc(5 + protobuf.length);
      response.writeUInt32BE(protobuf.length, 1);
      protobuf.copy(response, 5);
    }
    if (path === '/test.Service/Compressed') response[0] = 1;
    const responseHeaders = {
      ':status': 200,
      'content-type': 'application/grpc+proto',
    };
    if (path !== '/test.Service/MissingHeight') {
      responseHeaders['x-cosmos-block-height'] =
        headers['x-cosmos-block-height'] ?? '100';
    }
    stream.respond(responseHeaders, { waitForTrailers: true });
    stream.on('wantTrailers', () =>
      stream.sendTrailers(
        path === '/test.Service/MissingStatus'
          ? {}
          : { 'grpc-status': grpcStatus },
      ),
    );
    if (role === 'fast' && path.endsWith('/GetLatestValidatorSet'))
      setTimeout(() => stream.end(response), 50);
    else stream.end(response);
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});
