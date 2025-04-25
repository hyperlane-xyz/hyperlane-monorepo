import { serve } from '@hono/node-server';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { ModuleType } from '@hyperlane-xyz/sdk';

import { PolymerProvider } from './providers/polymer.js';

// Define the request schema
const FSRRequestSchema = z.object({
  ismModuleType: z.string(),
  directive: z.string(),
});

// Define the response schema
const FSRResponseSchema = z.object({
  result: z.string(),
  proof: z.string(),
});

type FSRRequest = z.infer<typeof FSRRequestSchema>;
export type FSRResponse = z.infer<typeof FSRResponseSchema>;

const app = new Hono();

// Initialize providers
const polymerProvider = new PolymerProvider(
  process.env.POLYMER_API_TOKEN || '',
  process.env.POLYMER_API_ENDPOINT || '',
);

// FSR request endpoint
app.post('/fsr_request', zValidator('json', FSRRequestSchema), async (c) => {
  const { ismModuleType, directive } = c.req.valid('json');

  // Route to appropriate provider
  switch (ismModuleType) {
    case ModuleType.POLYMER:
      const response = await polymerProvider.process(directive);
      return c.json(response, 200);
    default:
      return c.json(
        {
          success: false,
          error: `Unsupported provider type: ${ismModuleType}`,
        },
        400,
      );
  }
});

// Start the server
const port = process.env.PORT || 6060;
console.log(`FSR Server is running on port ${port}`);

serve({
  fetch: app.fetch,
  port: Number(port),
});
