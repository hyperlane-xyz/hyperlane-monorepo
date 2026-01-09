/**
 * Haggis Local Testing Server
 *
 * A lightweight HTTP server for testing Haggis without Slack.
 * Accepts POST requests with threadId and message, streams Claude's
 * responses back as NDJSON (newline-delimited JSON).
 *
 * Usage:
 *   pnpm haggis:local
 *
 * Test with curl:
 *   curl -X POST http://localhost:3456/query \
 *     -H "Content-Type: application/json" \
 *     -d '{"threadId": "test-1", "message": "hello"}'
 */
import http from 'node:http';

import { executeClaudeQuery } from './claude/executor.js';
import { logger } from './config.js';

const PORT = parseInt(process.env.HAGGIS_PORT || '3456', 10);

interface QueryRequest {
  threadId: string;
  message: string;
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

const server = http.createServer(async (req, res) => {
  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Query endpoint
  if (req.method === 'POST' && req.url === '/query') {
    try {
      const body = await parseBody(req);
      let parsed: QueryRequest;

      try {
        parsed = JSON.parse(body);
      } catch {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }

      const { threadId, message } = parsed;

      if (!threadId || typeof threadId !== 'string') {
        sendError(res, 400, 'Missing or invalid threadId');
        return;
      }

      if (!message || typeof message !== 'string') {
        sendError(res, 400, 'Missing or invalid message');
        return;
      }

      logger.info(
        { threadId, messageLength: message.length },
        'Received query',
      );

      // Stream NDJSON response
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        for await (const msg of executeClaudeQuery(threadId, message)) {
          res.write(JSON.stringify(msg) + '\n');
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        res.write(
          JSON.stringify({ type: 'error', content: errorMessage }) + '\n',
        );
      }

      res.end();
      return;
    } catch (error) {
      logger.error({ error }, 'Request handling failed');
      sendError(res, 500, 'Internal server error');
      return;
    }
  }

  // Not found
  sendError(res, 404, 'Not found');
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'Haggis local server started');
  console.log(`
Haggis Local Server running on http://localhost:${PORT}

Endpoints:
  POST /query  - Send a query to Claude
  GET  /health - Health check

Example:
  curl -X POST http://localhost:${PORT}/query \\
    -H "Content-Type: application/json" \\
    -d '{"threadId": "test-1", "message": "hello"}'
`);
});

// Graceful shutdown
const shutdown = (signal: string): void => {
  logger.info({ signal }, 'Received shutdown signal');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
