export async function revertMessage(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}
