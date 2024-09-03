import { DISALLOWED_URL_MSG } from './errors';

const GITHUB_API_ALLOWLIST = [
  'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main',
  'https://api.github.com/repos/hyperlane-xyz/hyperlane-registry',
];

export default {
  async fetch(request, env: any, _ctx): Promise<Response> {
    if (!canParseUrl(request.url)) {
      return new Response(DISALLOWED_URL_MSG, { status: 401 });
    }

    const apiUrl = getUrlPath(request.url);
    const allowablePath = getOriginWithPartialPath(apiUrl);
    if (!GITHUB_API_ALLOWLIST.includes(allowablePath)) {
      return new Response(DISALLOWED_URL_MSG, { status: 401 });
    }

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

/**
 * Checks if the provided URL can be parsed into a valid URL object.
 *
 * Example usage: https//api.hyperlane.xyz/favicon.ico
 * @param url - The URL to be parsed.
 * @returns `true` if the URL can be parsed, `false` otherwise.
 */
function canParseUrl(url: string): boolean {
  try {
    return !!getUrlPath(url);
  } catch (e) {
    return false;
  }
}

/**
 * Constructs the origin URL with the first three path segments of the provided API URL.
 * This is used to check if the API URL is in the allowlist.
 *
 * @param url - The URL of the API endpoint.
 * @returns The origin URL with the first three path segments.
 */
function getOriginWithPartialPath(url: URL): string {
  const origin = url.origin;
  const pathNames = url.pathname.split('/');
  return `${origin}/${pathNames[1]}/${pathNames[2]}/${pathNames[3]}`;
}

/**
 * Constructs a new URL object from the provided URL string, removing the leading slash from the pathname.
 *
 * @param url - The URL string to be parsed.
 * @returns A new URL object with the leading slash removed from the pathname.
 */
function getUrlPath(url: string): URL {
  return new URL(new URL(url).pathname.substring(1));
}
