import { PlannerOutputSchema } from './schema.js';
import type { PlannerClient } from './types.js';
import type { LoopContext, PlannerOutput } from '../types.js';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

export class ClaudePlannerClient implements PlannerClient {
  readonly provider = 'claude' as const;

  constructor(
    public readonly model: string,
    private readonly apiKey: string,
  ) {}

  async plan(context: LoopContext): Promise<{ prompt: string; output: PlannerOutput }> {
    const prompt = buildPrompt(context);

    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Claude planner call failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as any;
    const text = extractResponseText(json);
    const parsed = PlannerOutputSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`Invalid planner output from Claude: ${parsed.error.message}`);
    }

    return {
      prompt,
      output: parsed.data,
    };
  }
}

function buildPrompt(context: LoopContext): string {
  return [
    'You are a warp route rebalancer planner.',
    'Return STRICT JSON with fields summary and actions.',
    'Actions must include actionFingerprint, executionType, routeId, origin, destination, sourceRouter, destinationRouter, amount.',
    JSON.stringify(context),
  ].join('\n\n');
}

function extractResponseText(json: any): string {
  const content = Array.isArray(json.content) ? json.content : [];
  const texts = content
    .map((entry: any) => (entry?.type === 'text' ? entry.text : ''))
    .filter((value: string) => Boolean(value));

  const result = texts.join('\n').trim();
  if (!result) {
    throw new Error('No text output from Claude response');
  }
  return result;
}
