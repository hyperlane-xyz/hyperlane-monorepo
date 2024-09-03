// test/index.spec.ts
// import worker from '../src/index';
// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
// const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
import { DISALLOWED_URL_MSG } from '../src/errors.js';
import {
	/*env, createExecutionContext, waitOnExecutionContext,*/
	SELF,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Hello World worker', () => {
	// it('responds with Hello World! (unit style)', async () => {
	// 	const request = new IncomingRequest('http://example.com');
	// 	// Create an empty context to pass to `worker.fetch()`.
	// 	const ctx = createExecutionContext();
	// 	const response = await worker.fetch(request, env, ctx);
	// 	// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
	// 	await waitOnExecutionContext(ctx);
	// 	expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	// });
	it('returns empty response if pathname provided is not a valid api url', async () => {
		const results = await SELF.fetch('https://example.com/favicon.ico');

		expect(results.status).toBe(401);
		expect(await results.text()).toBe(DISALLOWED_URL_MSG);
	});

	it('returns empty response if origin is not on allowlist', async () => {
		const results = await SELF.fetch('https://example.com/https://api.hyperlane.xyz/repo/hyperlane-xyz/hyperlane-registry/git/trees/main');

		expect(results.status).toBe(401);
		expect(await results.text()).toBe(DISALLOWED_URL_MSG);
	});
});
