import http from 'node:http';

import { assert } from '@hyperlane-xyz/utils';

export const CLOSED_RPC_URL = 'http://127.0.0.1:1';

export interface JsonRpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

export type RpcResponder = (
  request: JsonRpcRequest,
  res: http.ServerResponse,
) => void;

export interface RpcServers {
  /** Starts a local JSON-RPC server answering through `respond`. */
  start(respond: RpcResponder): Promise<string>;
  /** Leaves a request unanswered until `close`. */
  hang(res: http.ServerResponse): void;
  close(): Promise<void>;
}

export function replyJson(res: http.ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseJsonRpcRequest(raw: string): JsonRpcRequest {
  const body: unknown = JSON.parse(raw);
  assert(
    typeof body === 'object' &&
      body !== null &&
      'id' in body &&
      typeof body.id === 'number' &&
      'method' in body &&
      typeof body.method === 'string' &&
      'params' in body &&
      Array.isArray(body.params),
    'Unexpected JSON-RPC body',
  );
  return { id: body.id, method: body.method, params: body.params };
}

export function createRpcServers(): RpcServers {
  const servers: http.Server[] = [];
  const hanging = new Set<http.ServerResponse>();

  return {
    async start(respond) {
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () =>
          respond(parseJsonRpcRequest(Buffer.concat(chunks).toString()), res),
        );
      });
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      assert(address && typeof address === 'object', 'Server not listening');
      return `http://127.0.0.1:${address.port}`;
    },
    hang(res) {
      hanging.add(res);
    },
    async close() {
      for (const res of hanging) res.destroy();
      hanging.clear();
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    },
  };
}
