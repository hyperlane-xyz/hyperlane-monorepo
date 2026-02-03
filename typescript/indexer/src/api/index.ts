import { Hono } from 'hono';

const app = new Hono();

// Ponder provides /health, /metrics, /status internally
// Add custom endpoints here if needed

export default app;
