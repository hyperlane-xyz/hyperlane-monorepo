"""Base collector with retry, rate limiting, and caching."""

import time
import requests
from typing import Optional, Any


class BaseCollector:
    """Base class for all data collectors with retry, rate limiting, and caching."""

    MIN_REQUEST_INTERVAL = 0.25  # 250ms between requests
    DEFAULT_TIMEOUT = 15
    DEFAULT_RETRIES = 3

    def __init__(self):
        self._last_request_time = 0
        self._cache: dict[str, tuple[Any, float]] = {}
        self._cache_ttl = 300  # 5 min default

    def _rate_limit(self):
        elapsed = time.time() - self._last_request_time
        if elapsed < self.MIN_REQUEST_INTERVAL:
            time.sleep(self.MIN_REQUEST_INTERVAL - elapsed)
        self._last_request_time = time.time()

    def _get_cached(self, key: str) -> Optional[Any]:
        if key in self._cache:
            value, ts = self._cache[key]
            if time.time() - ts < self._cache_ttl:
                return value
        return None

    def _set_cached(self, key: str, value: Any):
        self._cache[key] = (value, time.time())

    def fetch_json(self, url: str, method: str = "GET", json_body: dict = None,
                   headers: dict = None, params: dict = None,
                   retries: int = None, timeout: int = None) -> Optional[dict]:
        """Fetch JSON with retries and rate limiting."""
        retries = retries or self.DEFAULT_RETRIES
        timeout = timeout or self.DEFAULT_TIMEOUT

        for attempt in range(retries):
            self._rate_limit()
            try:
                if method.upper() == "POST":
                    resp = requests.post(url, json=json_body, headers=headers,
                                         params=params, timeout=timeout)
                else:
                    resp = requests.get(url, headers=headers, params=params,
                                        timeout=timeout)

                if resp.status_code == 200:
                    return resp.json()
                elif resp.status_code == 429:
                    wait = 2 * (attempt + 1)
                    print(f"  Rate limited on {url}, waiting {wait}s...")
                    time.sleep(wait)
                else:
                    print(f"  HTTP {resp.status_code} for {url}")
                    if attempt == retries - 1:
                        return None
            except requests.exceptions.Timeout:
                print(f"  Timeout fetching {url} (attempt {attempt + 1}/{retries})")
            except Exception as e:
                print(f"  Error fetching {url}: {e}")
                if attempt < retries - 1:
                    time.sleep(1)
        return None

    def rpc_call(self, rpc_url: str, method: str, params: list) -> Optional[Any]:
        """Generic JSON-RPC request."""
        self._rate_limit()
        try:
            resp = requests.post(
                rpc_url,
                json={"jsonrpc": "2.0", "method": method, "params": params, "id": 1},
                timeout=self.DEFAULT_TIMEOUT,
            )
            result = resp.json()
            if "error" in result:
                print(f"  RPC error on {method}: {result['error']}")
                return None
            return result.get("result")
        except Exception as e:
            print(f"  RPC error ({rpc_url} / {method}): {e}")
            return None
