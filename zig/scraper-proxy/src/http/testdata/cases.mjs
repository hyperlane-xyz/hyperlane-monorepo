// Raw HTTP exchange cases shared by gen-http-corpus.mjs (TS recordings for
// corpus_test.zig, TS-vs-binary diffs) and zig/scraper-proxy/parity/http (harness suite).
// Each case: [name, chunks (latin1 strings written in order), mode?].
const H = 'Host: a\r\n';
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const ws = (path, extra = '') =>
  `GET ${path} HTTP/1.1\r\n${H}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${KEY}\r\n${extra}\r\n`;

// Client WebSocket frame (masked unless mask: false). Returns latin1 text.
function frame(
  opcode,
  payload = '',
  { fin = true, mask = true, rsv = 0, len } = {},
) {
  const data = Buffer.from(payload, 'latin1');
  const n = len ?? data.length;
  const head = [(fin ? 0x80 : 0) | (rsv << 4) | opcode];
  const m = mask ? 0x80 : 0;
  if (n < 126) head.push(m | n);
  else if (n <= 0xffff) head.push(m | 126, n >> 8, n & 0xff);
  else {
    const big = Buffer.alloc(8);
    big.writeBigUInt64BE(BigInt(n));
    head.push(m | 127, ...big);
  }
  const key = [0x12, 0x34, 0x56, 0x78];
  if (mask) head.push(...key);
  const body = mask ? data.map((b, i) => b ^ key[i % 4]) : data;
  return Buffer.concat([Buffer.from(head), body]).toString('latin1');
}
const close = (code, reason = '') =>
  frame(
    8,
    code === undefined
      ? ''
      : String.fromCharCode(code >> 8, code & 0xff) + reason,
  );

// mode: 'full' compares every byte; 'metrics' masks the /metrics body and
// its content-length; 'head' compares only the response head; 'ws' compares the
// 101 head plus every non-text server frame and how the socket ended.
export const coreCases = [
  ['404 basic', [`GET /nope HTTP/1.1\r\n${H}\r\n`]],
  ['404 query in message', [`GET /nope?x=1&y=%20 HTTP/1.1\r\n${H}\r\n`]],
  ['404 HTTP/1.0 closes', [`GET /nope HTTP/1.0\r\n\r\n`]],
  [
    '404 HTTP/1.0 keep-alive',
    [`GET /nope HTTP/1.0\r\nConnection: keep-alive\r\n\r\n`],
  ],
  [
    '404 connection close',
    [`GET /nope HTTP/1.1\r\n${H}Connection: close\r\n\r\n`],
  ],
  ['404 absolute-form', [`GET http://x/nope HTTP/1.1\r\n${H}\r\n`]],
  ['404 asterisk', [`GET * HTTP/1.1\r\n${H}\r\n`]],
  ['404 delete graphql', [`DELETE /graphql HTTP/1.1\r\n${H}\r\n`]],
  [
    '404 post metrics',
    [
      `POST /metrics HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`,
    ],
  ],
  ['404 encoded slash', [`GET /graphql%2F HTTP/1.1\r\n${H}\r\n`]],
  ['404 double slash', [`GET /metrics// HTTP/1.1\r\n${H}\r\n`]],
  [
    '404 with origin',
    [`GET /nope HTTP/1.1\r\n${H}Origin: https://example.com\r\n\r\n`],
  ],
  ['404 empty origin', [`GET /nope HTTP/1.1\r\n${H}Origin: \r\n\r\n`]],
  ['404 head', [`HEAD /nope HTTP/1.1\r\n${H}\r\n`]],
  [
    '404 chunked body',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`,
    ],
  ],
  ['404 pipelined', [`GET /a HTTP/1.1\r\n${H}\r\nGET /b HTTP/1.1\r\n${H}\r\n`]],
  ['404 split head', [`GET /spl`, `it HTTP/1.1\r\n${H}`, `\r\n`]],
  ['404 leading CRLF', [`\r\nGET /nope HTTP/1.1\r\n${H}\r\n`]],
  [
    '404 duplicate origin',
    [
      `GET /nope HTTP/1.1\r\n${H}Origin: https://a\r\nOrigin: https://b\r\n\r\n`,
    ],
  ],
  ['bad url', [`GET /%zz HTTP/1.1\r\n${H}\r\n`]],
  ['missing host', [`GET /nope HTTP/1.1\r\n\r\n`]],
  ['expect unknown', [`GET /nope HTTP/1.1\r\n${H}Expect: foo\r\n\r\n`]],
  [
    'expect continue 404',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Length: 2\r\nExpect: 100-continue\r\n\r\n`,
      `{}`,
    ],
  ],
  ['garbage request line', [`GARBAGE\r\n\r\n`]],
  ['bad header name', [`GET / HTTP/1.1\r\n${H}Bad Header: x\r\n\r\n`]],
  ['HTTP/2.0 line', [`GET / HTTP/2.0\r\n${H}\r\n`]],
  ['obs-fold', [`GET / HTTP/1.1\r\n${H}X: a\r\n b\r\n\r\n`]],
  [
    'header overflow',
    [`GET / HTTP/1.1\r\n${H}X: ${'a'.repeat(17_000)}\r\n\r\n`],
  ],
  [
    'cl and te',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
    ],
  ],
  [
    'bad content-length',
    [`POST /nope HTTP/1.1\r\n${H}Content-Length: abc\r\n\r\n`],
  ],
  [
    'duplicate content-length',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Length: 1\r\nContent-Length: 2\r\n\r\nab`,
    ],
  ],
  [
    'bad chunk size',
    [`POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\nzz\r\n`],
  ],
  [
    'preflight ok',
    [
      `OPTIONS /graphql HTTP/1.1\r\n${H}Origin: https://a.b\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type, mercurius-require-preflight\r\n\r\n`,
    ],
  ],
  [
    'preflight no headers',
    [
      `OPTIONS /graphql HTTP/1.1\r\n${H}Origin: https://a.b\r\nAccess-Control-Request-Method: GET\r\n\r\n`,
    ],
  ],
  [
    'preflight missing origin',
    [
      `OPTIONS /graphql HTTP/1.1\r\n${H}Access-Control-Request-Method: GET\r\n\r\n`,
    ],
  ],
  [
    'preflight missing method',
    [`OPTIONS /graphql HTTP/1.1\r\n${H}Origin: https://a.b\r\n\r\n`],
  ],
  [
    'preflight unknown path',
    [
      `OPTIONS /nope HTTP/1.1\r\n${H}Origin: https://a.b\r\nAccess-Control-Request-Method: GET\r\n\r\n`,
    ],
  ],
  ['options bare', [`OPTIONS * HTTP/1.1\r\n${H}\r\n`]],
  [
    'metrics get',
    [`GET /metrics HTTP/1.1\r\n${H}Connection: close\r\n\r\n`],
    'metrics',
  ],
  [
    'metrics case and slash',
    [
      `GET /METRICS/ HTTP/1.1\r\n${H}Origin: http://o\r\nConnection: close\r\n\r\n`,
    ],
    'metrics',
  ],
  [
    'metrics head',
    [`HEAD /metrics HTTP/1.1\r\n${H}Connection: close\r\n\r\n`],
    'metrics',
  ],
  [
    'metrics query',
    [`GET /metrics?x=1 HTTP/1.1\r\n${H}Connection: close\r\n\r\n`],
    'metrics',
  ],
  [
    'upgrade unknown path',
    [
      `GET /x HTTP/1.1\r\n${H}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
    ],
  ],
  [
    'upgrade without connection header',
    [`GET /nope HTTP/1.1\r\n${H}Upgrade: websocket\r\n\r\n`],
  ],
  ['ws bad version', [ws('/agents', '').replace('Version: 13', 'Version: 12')]],
  [
    'ws missing version',
    [ws('/agents').replace('Sec-WebSocket-Version: 13\r\n', '')],
  ],
  ['ws bad key', [ws('/messages').replace(KEY, 'short')]],
  [
    'ws missing key',
    [ws('/messages').replace(`Sec-WebSocket-Key: ${KEY}\r\n`, '')],
  ],
  ['ws post method', [ws('/agents').replace('GET', 'POST')]],
  [
    'ws upgrade not websocket',
    [ws('/agents').replace('Upgrade: websocket', 'Upgrade: h2c')],
  ],
  ['ws bad protocol', [ws('/agents', 'Sec-WebSocket-Protocol: a, a\r\n')]],
  ['ws handshake agents', [ws('/agents')], 'head'],
  ['ws handshake messages query', [ws('/messages?x=1')], 'head'],
  [
    'ws handshake protocol',
    [ws('/agents', 'Sec-WebSocket-Protocol: chat, superchat\r\n')],
    'head',
  ],
  ['ws handshake case path', [ws('/Agents')]],
  // ws Receiver/Sender (frames after the handshake; data frames the live
  // stream sends are ignored by mode 'ws')
  ['ws ping pong', [ws('/messages'), frame(9, 'hi')], 'ws'],
  ['ws empty ping', [ws('/messages'), frame(9)], 'ws'],
  ['ws unsolicited pong', [ws('/messages'), frame(10, 'x')], 'ws'],
  ['ws unmasked', [ws('/messages'), frame(1, 'x', { mask: false })], 'ws'],
  ['ws rsv1', [ws('/messages'), frame(1, 'x', { rsv: 4 })], 'ws'],
  ['ws rsv2', [ws('/messages'), frame(1, 'x', { rsv: 2 })], 'ws'],
  ['ws opcode 3', [ws('/messages'), frame(3, 'x')], 'ws'],
  ['ws opcode 11', [ws('/messages'), frame(11, 'x')], 'ws'],
  [
    'ws fragmented ping',
    [ws('/messages'), frame(9, 'x', { fin: false })],
    'ws',
  ],
  ['ws long ping', [ws('/messages'), frame(9, 'x'.repeat(126))], 'ws'],
  ['ws close len 1', [ws('/messages'), frame(8, 'x')], 'ws'],
  ['ws close 1000', [ws('/messages'), close(1000, 'bye')], 'ws'],
  ['ws close empty', [ws('/messages'), close()], 'ws'],
  ['ws close 4000', [ws('/messages'), close(4000)], 'ws'],
  ['ws close 1005', [ws('/messages'), close(1005)], 'ws'],
  ['ws close 999', [ws('/messages'), close(999)], 'ws'],
  ['ws close 2000', [ws('/messages'), close(2000)], 'ws'],
  ['ws close bad utf8', [ws('/messages'), close(1000, '\u00ff')], 'ws'],
  ['ws text bad utf8', [ws('/messages'), frame(1, '\u00c3')], 'ws'],
  ['ws continuation first', [ws('/messages'), frame(0, 'x')], 'ws'],
  [
    'ws text inside fragment',
    [ws('/messages'), frame(1, 'a', { fin: false }), frame(1, 'b')],
    'ws',
  ],
  [
    'ws ping inside fragment',
    [ws('/messages'), frame(1, 'a', { fin: false }), frame(9, 'p')],
    'ws',
  ],
  ['ws over max payload', [ws('/messages'), frame(1, '', { len: 4097 })], 'ws'],
  [
    'ws at max payload header',
    [ws('/messages'), frame(1, '', { len: 4096 }).slice(0, 8)],
    'ws',
  ],
  [
    'ws fragments over max',
    [
      ws('/messages'),
      frame(1, 'a'.repeat(3000), { fin: false }),
      frame(0, 'b'.repeat(1200)),
    ],
    'ws',
  ],
  ['ws 2^53 length', [ws('/messages'), frame(2, '', { len: 2 ** 53 })], 'ws'],
  [
    'ws agents over max',
    [ws('/agents'), frame(2, '', { len: 1_048_577 })],
    'ws',
  ],
  [
    'ws data after close',
    [ws('/messages'), close(1000) + frame(9, 'late')],
    'ws',
  ],
  [
    'ws ping then close',
    [ws('/messages'), frame(9, 'a') + close(1001, 'x')],
    'ws',
  ],
  [
    'ws split frame',
    [
      ws('/messages'),
      frame(9, 'split').slice(0, 3),
      frame(9, 'split').slice(3),
    ],
    'ws',
  ],
  // llhttp acceptance
  ['HTTP/1.2', [`GET /nope HTTP/1.2\r\n${H}\r\n`]],
  ['HTTP/0.9', [`GET /nope HTTP/0.9\r\n${H}\r\n`]],
  ['HTTP/2.1', [`GET /nope HTTP/2.1\r\n${H}\r\n`]],
  ['lowercase method', [`get /nope HTTP/1.1\r\n${H}\r\n`]],
  ['unknown method', [`FOO /nope HTTP/1.1\r\n${H}\r\n`]],
  ['purge method', [`PURGE /nope HTTP/1.1\r\n${H}\r\n`]],
  ['query without content-type', [`QUERY /nope HTTP/1.1\r\n${H}\r\n`]],
  [
    'query without body',
    [`QUERY /nope HTTP/1.1\r\n${H}Content-Type: application/json\r\n\r\n`],
  ],
  ['connect', [`CONNECT a:443 HTTP/1.1\r\n${H}\r\n`]],
  ['h2 preface', [`PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`]],
  ['non-ascii url', [`GET /caf\u00c3\u00a9 HTTP/1.1\r\n${H}\r\n`]],
  [
    'non-ascii header value',
    [`GET /nope HTTP/1.1\r\n${H}X: caf\u00c3\u00a9\r\n\r\n`],
  ],
  [
    'control char header value',
    [`GET /nope HTTP/1.1\r\n${H}X: a\u0001b\r\n\r\n`],
  ],
  ['space before colon', [`GET /nope HTTP/1.1\r\nHost : a\r\n\r\n`]],
  ['double space request line', [`GET  /nope HTTP/1.1\r\n${H}\r\n`]],
  ['bare LF', [`GET /nope HTTP/1.1\n${H}\n`]],
  ['empty header value', [`GET /nope HTTP/1.1\r\n${H}X:\r\n\r\n`]],
  ['empty host', [`GET /nope HTTP/1.1\r\nHost:\r\n\r\n`]],
  ['duplicate host', [`GET /nope HTTP/1.1\r\n${H}Host: b\r\n\r\n`]],
  ['lowercase host', [`GET /nope HTTP/1.1\r\nhost: a\r\n\r\n`]],
  [
    'header limit ok',
    [`GET /nope HTTP/1.1\r\n${H}X: ${'a'.repeat(16_408 - 36)}\r\n\r\n`],
  ],
  [
    'header limit exceeded',
    [`GET /nope HTTP/1.1\r\n${H}X: ${'a'.repeat(16_409 - 36)}\r\n\r\n`],
  ],
  [
    'content-length plus',
    [`POST /nope HTTP/1.1\r\n${H}Content-Length: +3\r\n\r\nabc`],
  ],
  [
    'content-length spaces',
    [`POST /nope HTTP/1.1\r\n${H}Content-Length:  3 \r\n\r\nabc`],
  ],
  [
    'te gzip with body',
    [`POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: gzip\r\n\r\nabc`],
  ],
  [
    'te gzip chunked',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n`,
    ],
  ],
  [
    'te chunked gzip',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked, gzip\r\n\r\n0\r\n\r\n`,
    ],
  ],
  [
    'te chunked twice',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
    ],
  ],
  // Request smuggling guards (llhttp HPE_INVALID_TRANSFER_ENCODING / chunk size)
  [
    'te gzip smuggled request',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: gzip\r\n\r\nGET /metrics HTTP/1.1\r\n${H}\r\n`,
    ],
  ],
  [
    'te gzip no body',
    [`POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: gzip\r\n\r\n`],
  ],
  [
    'te gzip json 404',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Type: application/json\r\nTransfer-Encoding: gzip\r\n\r\n{}`,
    ],
  ],
  [
    'te gzip json graphql',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: application/json\r\nTransfer-Encoding: gzip\r\n\r\n{"query":"{__typename}"}`,
    ],
  ],
  [
    'te gzip connection close',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: gzip\r\nConnection: close\r\n\r\n`,
    ],
  ],
  ...[
    ['plus', '+a'],
    ['underscore', '1_0'],
    ['trailing space', 'a '],
    ['leading space', ' a'],
    ['0x', '0xa'],
    ['space before ext', 'a ;x=1'],
    ['empty ext', 'a;'],
    ['space in ext', 'a; x=1'],
    ['unterminated quote', 'a;x="open'],
    ['bad ext value', 'a;x=@'],
    ['overflow', 'ffffffffffffffffff'],
  ].map(([name, line]) => [
    `chunk size ${name}`,
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n${line}\r\n0123456789abcdef\r\n0\r\n\r\n`,
    ],
  ]),
  ...[
    ['uppercase', 'A'],
    ['leading zeros', '000a'],
    ['ext token', 'a;x=1;y=2'],
    ['ext bare', 'a;x'],
    ['ext empty value', 'a;x='],
    ['ext quoted', 'a;x="q\\"z"'],
  ].map(([name, line]) => [
    `chunk size ok ${name}`,
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n${line}\r\n0123456789\r\n0\r\n\r\nGET /after HTTP/1.1\r\n${H}\r\n`,
    ],
  ]),
  [
    'chunk data without CRLF',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n2\r\nabX\r\n0\r\n\r\n`,
    ],
  ],
  [
    'chunk bad trailer',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n0\r\nBad Trailer\r\n\r\n`,
    ],
  ],
  [
    'chunk trailer no space',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n0\r\nX:y\r\n\r\nGET /after HTTP/1.1\r\n${H}\r\n`,
    ],
  ],
  [
    'chunk extension and trailer',
    [
      `POST /nope HTTP/1.1\r\n${H}Transfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n0\r\nTrailer: x\r\n\r\n`,
    ],
  ],
  [
    'expect continue mixed case',
    [`GET /nope HTTP/1.1\r\n${H}Expect: 100-Continue, foo\r\n\r\n`],
  ],
  ['expect on HTTP/1.0', [`GET /nope HTTP/1.0\r\nExpect: foo\r\n\r\n`]],
  [
    'expect unknown close',
    [`GET /nope HTTP/1.1\r\n${H}Expect: foo\r\nConnection: close\r\n\r\n`],
  ],
  // find-my-way URLs
  ['bad url query', [`GET /%zz?x=1 HTTP/1.1\r\n${H}\r\n`]],
  ['bad url utf8', [`GET /%E0%A4 HTTP/1.1\r\n${H}\r\n`]],
  ['bad url truncated', [`DELETE /a%2 HTTP/1.1\r\n${H}\r\n`]],
  ['bad url absolute', [`GET http://x/%zz HTTP/1.1\r\n${H}\r\n`]],
  ['bad url fragment authority', [`GET http://x#a HTTP/1.1\r\n${H}\r\n`]],
  ['url relative word', [`GET abc HTTP/1.1\r\n${H}\r\n`]],
  ['url query only', [`GET ?x HTTP/1.1\r\n${H}\r\n`]],
  ['url scheme without slashes', [`GET http:x HTTP/1.1\r\n${H}\r\n`]],
  [
    'url userinfo',
    [`GET http://u:p@x:1/metrics HTTP/1.1\r\n${H}Connection: close\r\n\r\n`],
    'metrics',
  ],
  ['url ftp scheme', [`GET ftp://x/metrics HTTP/1.1\r\n${H}\r\n`]],
  ['url bad port', [`GET http://x:ab/metrics HTTP/1.1\r\n${H}\r\n`]],
  ['garbage no CRLF', [`abc`]],
  ['bad url quote', [`GET /%zz%22 HTTP/1.1\r\n${H}Connection: close\r\n\r\n`]],
  ['encoded reserved', [`GET /%41%2F HTTP/1.1\r\n${H}\r\n`]],
  ['quote in url', [`GET /q"\\x HTTP/1.1\r\n${H}\r\n`]],
  [
    'encoded metrics',
    [`GET /%6Detrics HTTP/1.1\r\n${H}Connection: close\r\n\r\n`],
    'metrics',
  ],
  [
    'metrics bad query',
    [`GET /METRICS?%zz HTTP/1.1\r\n${H}Connection: close\r\n\r\n`],
    'metrics',
  ],
  [
    'absolute metrics',
    [`GET HTTP://X/metrics?a HTTP/1.1\r\n${H}Connection: close\r\n\r\n`],
    'metrics',
  ],
  ['absolute no path', [`GET http://x HTTP/1.1\r\n${H}\r\n`]],
  ['fragment', [`GET /a#b HTTP/1.1\r\n${H}\r\n`]],
  ['leading double slash', [`GET //metrics HTTP/1.1\r\n${H}\r\n`]],
  // Fastify body handling on the 404 route
  [
    '404 unknown content-type',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Type: application/xml\r\nContent-Length: 4\r\n\r\n<a/>`,
    ],
  ],
  [
    '404 invalid json',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 1\r\n\r\n{`,
    ],
  ],
  [
    '404 empty json',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 0\r\n\r\n`,
    ],
  ],
  [
    '404 too large',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 200000\r\n\r\n{`,
    ],
  ],
  [
    '404 chunked too large',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n19001\r\n${'a'.repeat(0x19001)}\r\n0\r\n\r\n`,
    ],
  ],
  [
    '404 invalid content-type',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Type: ;;\r\nContent-Length: 4\r\n\r\nabcd`,
    ],
  ],
  [
    '404 no content-type body',
    [`POST /nope HTTP/1.1\r\n${H}Content-Length: 5\r\n\r\nhello`],
  ],
  [
    '404 text body',
    [
      `POST /metrics HTTP/1.1\r\n${H}Content-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello`,
    ],
  ],
  [
    '404 delete xml',
    [
      `DELETE /nope HTTP/1.1\r\n${H}Content-Type: application/xml\r\nContent-Length: 4\r\n\r\n<a/>`,
    ],
  ],
  [
    '404 delete invalid json',
    [
      `DELETE /nope HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 1\r\n\r\n{`,
    ],
  ],
  [
    '404 put json ok',
    [
      `PUT /nope HTTP/1.1\r\n${H}Content-Type: application/json; charset=utf-8\r\nContent-Length: 2\r\n\r\n{}`,
    ],
  ],
  [
    '404 json bad utf8 length',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 3\r\n\r\n"\u00ff"`,
    ],
  ],
  [
    '404 json proto',
    [
      `POST /nope HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 18\r\n\r\n{"__proto__":{}}  `,
    ],
  ],
  [
    '404 get with body',
    [
      `GET /nope HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 1\r\n\r\n{`,
    ],
  ],
  [
    'metrics with json body',
    [
      `GET /metrics HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 1\r\nConnection: close\r\n\r\n{`,
    ],
    'metrics',
  ],
  [
    'options with body',
    [
      `OPTIONS /nope HTTP/1.1\r\n${H}Content-Type: application/xml\r\nContent-Length: 4\r\n\r\n<a/>`,
    ],
  ],
  [
    'keep-alive after 404 body',
    [
      `POST /a HTTP/1.1\r\n${H}Content-Length: 5\r\n\r\nhelloGET /b HTTP/1.1\r\n${H}\r\n`,
    ],
  ],
];

// `app` mode: cases whose responses come from GraphQL/live logic; used to
// diff the TS server against the full Zig binary, not by corpus_test.zig.
const json = (body, extra = '') =>
  `POST /graphql HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`;
const q = (query) => JSON.stringify({ query });
export const appCases = [
  ['gql post', [json(q('{ domain(limit: 1) { id name } }'))]],
  [
    'gql post origin',
    [json(q('{ domain(limit: 1) { id } }'), 'Origin: https://example.com\r\n')],
  ],
  [
    'gql trailing slash case',
    [json(q('{ domain(limit: 1) { id } }')).replace('/graphql', '/GraphQL/')],
  ],
  [
    'gql head',
    [
      `HEAD /graphql?query=%7B__typename%7D HTTP/1.1\r\n${H}mercurius-require-preflight: 1\r\n\r\n`,
    ],
  ],
  [
    'gql get csrf',
    [`GET /graphql?query=%7B__typename%7D HTTP/1.1\r\n${H}\r\n`],
  ],
  [
    'gql get preflight header',
    [
      `GET /graphql?query=%7B__typename%7D HTTP/1.1\r\n${H}x-apollo-operation-name: a\r\n\r\n`,
    ],
  ],
  [
    'gql get no query',
    [`GET /graphql HTTP/1.1\r\n${H}mercurius-require-preflight: 1\r\n\r\n`],
  ],
  [
    'gql xml',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: application/xml\r\nContent-Length: 4\r\n\r\n<a/>`,
    ],
  ],
  [
    'gql text plain csrf',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: text/plain\r\nContent-Length: 18\r\n\r\nquery={domain{id}}`,
    ],
  ],
  [
    'gql form csrf',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: application/x-www-form-urlencoded\r\nContent-Length: 5\r\n\r\na=b&c`,
    ],
  ],
  [
    'gql application/graphql',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: application/graphql\r\nContent-Length: 14\r\n\r\n{ __typename }`,
    ],
  ],
  ['gql invalid json', [json('{')]],
  [
    'gql empty json',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 0\r\n\r\n`,
    ],
  ],
  [
    'gql too large',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 200000\r\n\r\n{`,
    ],
  ],
  [
    'gql no content-type',
    [`POST /graphql HTTP/1.1\r\n${H}Content-Length: 2\r\n\r\n{}`],
  ],
  [
    'gql invalid content-type',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: ;;\r\nContent-Length: 2\r\n\r\n{}`,
    ],
  ],
  ['gql batch', [json('[{"query":"{ __typename }"}]')]],
  ['gql syntax error', [json(q('{'))]],
  ['gql validation error', [json(q('{ missing }'))]],
  ['gql introspection', [json(q('{ __schema { queryType { name } } }'))]],
  [
    'gql cached',
    [json(q('query @cached(ttl: 30) { domain(limit: 1) { id } }'))],
  ],
  [
    'gql chunked',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1d\r\n{"query":"{ __typename }"}  \r\n0\r\n\r\n`,
    ],
  ],
  [
    'gql expect continue',
    [
      `POST /graphql HTTP/1.1\r\n${H}Content-Type: application/json\r\nContent-Length: 26\r\nExpect: 100-continue\r\n\r\n`,
      `{"query":"{ __typename }"}`,
    ],
  ],
  ['gql pipelined', [json(q('{ __typename }')) + json(q('{ __typename }'))]],
  [
    'gql options preflight',
    [
      `OPTIONS /graphql HTTP/1.1\r\n${H}Origin: https://a\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type\r\n\r\n`,
    ],
  ],
  ['ws agents ready', [ws('/agents')], 'full'],
  ['ws messages ready', [ws('/messages')], 'full'],
  ['ws messages bad param', [ws('/messages?confirmations=abc')], 'full'],
  ['ws agents invalid json', [ws('/agents'), frame(1, 'not json')], 'full'],
];
