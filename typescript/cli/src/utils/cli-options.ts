// Functions used to manipulate CLI specific options

/**
 * Calculates the page size for a CLI Terminal output, taking into account the number of lines to skip and a default page size.
 *
 * @param skipSize - The number of lines to skip, which can be used to skip previous prompts.
 * @param defaultPageSize - The default page size to use if the terminal height is too small.
 * @returns The calculated pageSize, which is the terminal height minus the skip size, or the default page size if the terminal height is too small.
 */
export function calculatePageSize(
  skipSize: number = 0,
  defaultPageSize: number = 15,
) {
  return process.stdout.rows > skipSize
    ? process.stdout.rows - skipSize
    : defaultPageSize;
}
