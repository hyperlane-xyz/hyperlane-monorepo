/**
 * Runner for executing evals through Claude Code using the Agent SDK.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { EvalResult } from './types.js';

/** Default max turns for Claude Code execution */
const DEFAULT_MAX_TURNS = 30;

/** Working directory for Claude Code - repo root is 3 levels up from src/ */
const CWD = join(import.meta.dirname, '..', '..', '..');

/**
 * Run an eval by executing its prompt through Claude Code.
 *
 * @param promptPath - Path to the eval-prompt.md file
 * @returns The eval result including Claude's response and cost
 */
export async function runEval(promptPath: string): Promise<EvalResult> {
  const prompt = await readFile(promptPath, 'utf-8');
  const evalPath = dirname(promptPath);
  const evalName = `${basename(dirname(evalPath))}/${basename(evalPath)}`;

  console.log(`\n  Running: ${evalName}`);
  const start = Date.now();

  let result = '';
  let cost = 0;

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: CWD,
        settingSources: ['project', 'user'],
        maxTurns: DEFAULT_MAX_TURNS,
        permissionMode: 'bypassPermissions',
      },
    })) {
      // Capture final result
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          result = (message as any).result || 'Task completed';
          cost = (message as any).total_cost_usd || 0;
        } else {
          // Error or other result type
          result = `Eval ended with status: ${message.subtype}`;
          cost = (message as any).total_cost_usd || 0;
        }
      }

      // Log tool calls for visibility
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('name' in block) {
            const toolName = (block as any).name;
            process.stdout.write(`    → ${toolName}\n`);
          }
        }
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    result = `Error: ${errorMessage}`;
  }

  const durationMs = Date.now() - start;

  return {
    evalPath,
    prompt,
    result,
    cost,
    durationMs,
  };
}
