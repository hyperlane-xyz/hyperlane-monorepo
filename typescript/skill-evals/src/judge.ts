/**
 * Haiku-based judge for evaluating Claude Code results against expectations.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';

import type { JudgeResult } from './types.js';

/** Haiku model for judging */
const JUDGE_MODEL = 'claude-3-5-haiku-20241022';

/** System prompt for the judge */
const JUDGE_SYSTEM_PROMPT = `You are evaluating if a Claude Code result meets expectations.

Compare the RESULT against the EXPECTED outcomes. The result does NOT need to match word-for-word.
Instead, evaluate whether the result covers all the KEY POINTS described in the expected outcomes.

Consider a result passing if it:
- Addresses the main objective(s) in the expected outcomes
- Covers the essential steps or findings
- Arrives at a correct or reasonable conclusion

Consider a result failing if it:
- Misses critical key points from the expected outcomes
- Contains factual errors about the main topic
- Fails to complete the core task described

Be lenient with formatting differences, additional helpful information, or minor variations in approach.

Respond with ONLY valid JSON in this exact format:
{"pass": true/false, "reasoning": "brief explanation (1-2 sentences)"}`;

/** Input token cost for Haiku per million tokens */
const HAIKU_INPUT_COST_PER_M = 0.8;
/** Output token cost for Haiku per million tokens */
const HAIKU_OUTPUT_COST_PER_M = 4.0;

/**
 * Calculate cost from API usage.
 */
function calculateCost(usage: {
  input_tokens: number;
  output_tokens: number;
}): number {
  const inputCost = (usage.input_tokens / 1_000_000) * HAIKU_INPUT_COST_PER_M;
  const outputCost =
    (usage.output_tokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;
  return inputCost + outputCost;
}

/**
 * Use Haiku to judge if a result meets the expected outcomes.
 *
 * @param result - The Claude Code result to evaluate
 * @param expectedPath - Path to the eval-expected.md file
 * @returns The judge's evaluation
 */
export async function judgeResult(
  result: string,
  expectedPath: string,
): Promise<JudgeResult> {
  const expected = await readFile(expectedPath, 'utf-8');

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required for the judge. ' +
        'Set it with: export ANTHROPIC_API_KEY=sk-ant-...',
    );
  }

  const client = new Anthropic();

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 500,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `EXPECTED OUTCOMES:\n${expected}\n\nACTUAL RESULT:\n${result}`,
      },
    ],
  });

  // Calculate cost
  const judgeCost = calculateCost(response.usage);

  // Parse JSON response
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return {
      pass: false,
      reasoning: 'Judge did not return a text response',
      judgeCost,
    };
  }

  try {
    const json = JSON.parse(textBlock.text);
    return {
      pass: Boolean(json.pass),
      reasoning: String(json.reasoning || 'No reasoning provided'),
      judgeCost,
    };
  } catch {
    // If JSON parsing fails, try to extract pass/fail from text
    const text = textBlock.text.toLowerCase();
    const pass = text.includes('"pass": true') || text.includes('"pass":true');
    return {
      pass,
      reasoning: `Failed to parse judge response: ${textBlock.text.slice(0, 100)}`,
      judgeCost,
    };
  }
}
