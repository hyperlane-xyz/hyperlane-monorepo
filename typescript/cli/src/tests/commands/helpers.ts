import { ProcessOutput, ProcessPromise } from 'zx';

import { inCIMode, sleep } from '@hyperlane-xyz/utils';

// Verifies if the IS_CI var is set and generates the correct prefix for running the command
// in the current env
export function localTestRunCmdPrefix() {
  return inCIMode() ? [] : ['yarn', 'workspace', '@hyperlane-xyz/cli', 'run'];
}

export enum KeyBoardKeys {
  ARROW_DOWN = '\x1b[B',
  ARROW_UP = '\x1b[A',
  ENTER = '\n',
  TAB = '\t',
  ACCEPT = 'y',
  DECLINE = 'n',
}

export type TestPromptAction = {
  check: (currentOutput: string) => boolean;
  input: string;
};

export const SELECT_MAINNET_CHAIN_TYPE_STEP: TestPromptAction = {
  check: (currentOutput: string) =>
    currentOutput.includes('Select network type'),
  // Select mainnet chains
  input: KeyBoardKeys.ENTER,
};

export const SETUP_CHAIN_SIGNER_MANUALLY_STEP = (
  privateKey: string,
): Readonly<TestPromptAction> => ({
  check: (currentOutput) =>
    currentOutput.includes('Please enter the private key for chain'),
  input: `${privateKey}${KeyBoardKeys.ENTER}`,
});

export const CONFIRM_DETECTED_OWNER_STEP: Readonly<TestPromptAction> = {
  check: (currentOutput: string) =>
    currentOutput.includes('Using owner address as'),
  input: KeyBoardKeys.ENTER,
};

export const SELECT_NATIVE_TOKEN_TYPE = {
  check: (currentOutput: string) =>
    !!currentOutput.match(/Select .+?'s token type/),
  // Scroll up through the token type list and select native
  input: `${KeyBoardKeys.ARROW_UP.repeat(5)}${KeyBoardKeys.ENTER}`,
};

/**
 * Maximum line length for buffering stdout chunks.
 * This prevents memory issues from extremely long lines.
 */
const MAX_LINE_LENGTH = 2048;

/**
 * Takes a {@link ProcessPromise} and a list of inputs that will be supplied
 * in the provided order when the check in the {@link TestPromptAction} matches the output
 * of the {@link ProcessPromise}.
 *
 * The function buffers stdout chunks and processes them line by line to handle
 * cases where prompts might be split across multiple chunks.
 */
export async function handlePrompts(
  processPromise: Readonly<ProcessPromise>,
  actions: TestPromptAction[],
): Promise<ProcessOutput> {
  let expectedStep = 0;
  let buffer = '';

  for await (const out of processPromise.stdout) {
    buffer += out.toString();

    // Enforce maximum buffer size for memory safety
    if (buffer.length > MAX_LINE_LENGTH) {
      buffer = buffer.slice(-MAX_LINE_LENGTH);
    }

    // Process complete lines from the buffer
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      const currentAction = actions[expectedStep];
      if (currentAction && currentAction.check(line)) {
        await asyncStreamInputWrite(processPromise.stdin, currentAction.input);
        expectedStep++;
      }
    }

    // Also check the current buffer content (for prompts that don't end with newline)
    const currentAction = actions[expectedStep];
    if (currentAction && currentAction.check(buffer)) {
      await asyncStreamInputWrite(processPromise.stdin, currentAction.input);
      expectedStep++;
      buffer = ''; // Clear buffer after successful match
    }
  }

  return processPromise;
}

export async function asyncStreamInputWrite(
  stream: NodeJS.WritableStream,
  data: string | Buffer,
): Promise<void> {
  stream.write(data);
  // Adding a slight delay to allow the buffer to update the output
  await sleep(500);
}

export async function restoreSnapshot(
  stream: NodeJS.WritableStream,
  data: string | Buffer,
): Promise<void> {
  stream.write(data);
  // Adding a slight delay to allow the buffer to update the output
  await sleep(500);
}
