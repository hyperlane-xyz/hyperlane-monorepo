import { DISALLOWED_URL_MSG } from './errors.js';

const GITHUB_API_ALLOWLIST = [
  '/repos/hyperlane-xyz/hyperlane-registry/git/trees/main',
];
const GITHUB_API_HOST = 'https://api.github.com';
export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const apiUrlPath = new URL(request.url).pathname;
    const isAllowed = GITHUB_API_ALLOWLIST.includes(apiUrlPath);
    if (!isAllowed) {
      return new Response(DISALLOWED_URL_MSG, { status: 401 });
    }

    const apiUrl = new URL(`${GITPUB_API_HOST}${apiUrlPath}?recursive=true`);
    return fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Hyperlane-Github-Proxy',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${env.GITHUB_API_KEY}`,
      },
    });
  },
} satisfies ExportedHandler<Env>;
