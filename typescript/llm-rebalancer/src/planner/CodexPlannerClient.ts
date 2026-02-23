import { PlannerOutputSchema } from './schema.js';
import type { PlannerClient } from './types.js';
import type { LoopContext, PlannerOutput } from '../types.js';

const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

export class CodexPlannerClient implements PlannerClient {
  readonly provider = 'codex' as const;

  constructor(
    public readonly model: string,
    private readonly apiKey: string,
  ) {}

  async plan(context: LoopContext): Promise<{ prompt: string; output: PlannerOutput }> {
    const prompt = buildPrompt(context);

    const response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Codex planner call failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as any;
    const text = extractResponseText(json);
    const parsed = PlannerOutputSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`Invalid planner output from Codex: ${parsed.error.message}`);
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
  if (typeof json.output_text === 'string' && json.output_text.length > 0) {
    return json.output_text;
  }

  const chunks: string[] = [];
  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (typeof content?.text === 'string') {
        chunks.push(content.text);
      }
    }
  }

  const result = chunks.join('\n').trim();
  if (!result) {
    throw new Error('No text output from Codex response');
  }
  return result;
}
