import { Hono } from 'hono';

/**
 * Ponder API endpoints.
 *
 * This file is required by the Ponder framework - builds fail without it.
 * See: https://ponder.sh/docs/api-reference/ponder/api-endpoints
 *
 * Ponder provides /health, /metrics, /status internally.
 * Add custom endpoints here if needed.
 */
const app = new Hono();

export default app;
