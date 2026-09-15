import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

export function createApiKeyAuth(apiKeys: Set<string>, logger: Logger) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      logger.warn(
        { path: request.routeOptions.url },
        'Missing or malformed Authorization header',
      );
      return reply.code(401).send({ message: 'Unauthorized' });
    }

    const key = header.slice(7);
    if (!apiKeys.has(key)) {
      logger.warn({ path: request.routeOptions.url }, 'Invalid API key');
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  };
}
