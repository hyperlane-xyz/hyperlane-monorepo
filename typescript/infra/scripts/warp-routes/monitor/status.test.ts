• Verify Jest setup:
  – Ensure `jest.config.js` or `package.json` contains Jest entries.
  – Confirm `ts-jest` is configured for TypeScript.

• Identify SUT (typescript/infra/scripts/warp-routes/monitor/status.ts):
  – Exports:
    • `fetchStatus(id: string): Promise<Status>`
    • `parseStatus(raw: any): Status`
    • `StatusError` (custom error class)

• Test cases:

  1. Happy‐path for fetchStatus:
     – Mock HTTP client (e.g., `jest.mock('axios')`) to return HTTP 200 with valid payload.
     – Assert `await fetchStatus('abc')` resolves to expected `Status` object.

  2. Edge cases for parseStatus:
     – Valid payload missing optional fields → default values applied.
     – Empty/null input → throws `StatusError` with descriptive message.

  3. Failure paths for fetchStatus:
     – HTTP 4xx/5xx response → rejects with `StatusError` including status code.
     – Network error (e.g., timeout) → rejects with underlying error or wrapped `StatusError`.

  4. Input validation:
     – Call `fetchStatus('')` (empty ID) → immediate rejection with `StatusError`.

  5. Concurrency/timing (if applicable):
     – If retry/backoff logic exists, use `jest.useFakeTimers()` and `jest.advanceTimersByTime()` to simulate delays and retries.

• Mocking & lifecycle:
  – Use `jest.mock('axios')` or equivalent.
  – In `beforeEach`, reset and configure mocks.
  – In `afterEach`, `jest.resetAllMocks()` and restore any modified `process.env`.

• Async assertions:
  – Use `await expect(fetchStatus(...)).resolves.toEqual(...)`.
  – Use `await expect(fetchStatus(...)).rejects.toThrow(StatusError)`.

• Coverage goals:
  – Target >90% branch coverage on `status.ts`.
  – Run via `npm test` or `yarn test`; use `jest.setTimeout()` if any test is long‐running.