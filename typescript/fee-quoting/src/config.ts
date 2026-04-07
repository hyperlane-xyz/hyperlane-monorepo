import { z } from 'zod';

import { DEFAULT_PORT, DEFAULT_QUOTE_EXPIRY_SECONDS } from './constants.js';

export const QuoteMode = {
  /** Transient: single-use, scoped to sender, submitted via QuotedCalls.SUBMIT_QUOTE */
  TRANSIENT: 'transient',
  /** Standing: reusable, submitted directly to quoter, persists until expiry */
  STANDING: 'standing',
} as const;

export type QuoteMode = (typeof QuoteMode)[keyof typeof QuoteMode];

export const ServerConfigSchema = z.object({
  signerKey: z.string().startsWith('0x').min(66).max(66),
  warpRouteIds: z.array(z.string().min(1)).min(1),
  registryUri: z.string().min(1),
  apiKeys: z.array(z.string().min(1)).min(1),
  port: z.number().int().positive().default(DEFAULT_PORT),
  /** Quote mode: 'transient' (single-use via QuotedCalls) or 'standing' (reusable, direct submission) */
  quoteMode: z.enum(['transient', 'standing']).default('transient'),
  /** Quote TTL in seconds (standing mode only) */
  quoteExpiry: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_QUOTE_EXPIRY_SECONDS),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
