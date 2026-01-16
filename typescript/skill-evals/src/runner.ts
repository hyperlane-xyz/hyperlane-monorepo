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

/** Tools allowed during eval runs (read-only operations + MCP) */
const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Skill',
  'Task',
  'TodoWrite',
  'mcp__grafana__*',
  'mcp__hyperlane-explorer__*',
];

/**
 * Run an eval by executing its prompt through Claude Code.
 *
 * @param promptPath - Path to the eval-prompt.md file
 * @param verbose - Whether to output detailed agent interactions
 * @returns The eval result including Claude's response and cost
 */
export async function runEval(
  promptPath: string,
  verbose: boolean = false,
): Promise<EvalResult> {
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
        allowedTools: ALLOWED_TOOLS,
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

      // Log agent interactions
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('name' in block) {
            const toolName = (block as any).name;
            process.stdout.write(`    → ${toolName}\n`);
          } else if (verbose && 'text' in block) {
            // In verbose mode, show assistant text
            const text = (block as any).text;
            const indented = text
              .split('\n')
              .map((line: string) => `    │ ${line}`)
              .join('\n');
            process.stdout.write(`${indented}\n`);
          }
        }
      }

      // In verbose mode, show tool results
      if (verbose && message.type === 'user' && message.message?.content) {
        for (const block of message.message.content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            (block as any).type === 'tool_result'
          ) {
            const toolResult = block as any;
            const content =
              typeof toolResult.content === 'string'
                ? toolResult.content
                : JSON.stringify(toolResult.content, null, 2);
            // Truncate long results
            const truncated =
              content.length > 500
                ? content.slice(0, 500) + '... (truncated)'
                : content;
            const indented = truncated
              .split('\n')
              .map((line: string) => `    ┊ ${line}`)
              .join('\n');
            process.stdout.write(`${indented}\n`);
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
