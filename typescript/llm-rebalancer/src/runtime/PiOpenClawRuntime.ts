import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeConfig } from '../types.js';
import type {
  AgentRuntime,
  SkillInvocation,
  SkillInvocationResult,
} from './types.js';

export class PiOpenClawRuntime implements AgentRuntime {
  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async invokeSkill(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    const dir = await mkdtemp(join(tmpdir(), 'hl-llm-rebalancer-'));
    const inputPath = join(dir, `skill-input-${invocation.runId}.json`);
    const outputPath = join(dir, `skill-output-${invocation.runId}.json`);

    await writeFile(inputPath, JSON.stringify(invocation.input), 'utf8');

    const args = this.runtimeConfig.argsTemplate.map((arg) =>
      arg
        .replace('{skillPath}', invocation.skillPath)
        .replace('{inputPath}', inputPath)
        .replace('{outputPath}', outputPath),
    );

    const result = await this.runCommand(args);
    const stdout = result.stdout;
    const stderr = result.stderr;
    if (result.exitCode !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(
        `Skill execution failed (${invocation.skillPath}) with code ${result.exitCode}: ${stderr || stdout}`,
      );
    }

    const output = await this.loadOutput(outputPath, stdout);

    await rm(dir, { recursive: true, force: true });

    return {
      output,
      stdout,
      stderr,
    };
  }

  private async loadOutput(outputPath: string, stdout: string): Promise<unknown> {
    try {
      const output = await readFile(outputPath, 'utf8');
      return JSON.parse(output) as unknown;
    } catch {
      return this.tryParseStdout(stdout);
    }
  }

  private tryParseStdout(stdout: string): unknown {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return { raw: trimmed };
    }
  }

  private runCommand(args: string[]): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.runtimeConfig.command, args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.runtimeConfig.timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(
            new Error(
              `Skill command timed out after ${this.runtimeConfig.timeoutMs}ms`,
            ),
          );
          return;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}
