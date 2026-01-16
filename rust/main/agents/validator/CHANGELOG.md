## [2.0.0] - 2026-01-06

* feat(rust): feature-gate Aleo chain support to reduce CI build times (#7569)
* feat: Aleo HyperlaneProvider (#7344)
* feat: aleo fallback provider (#7407)
* feat: aleo validator announce (#7445)
* feat: crash loop even in the event `reorg_flag.json` is unparsable (#7464)
* refactor: Remove duplication and move tests into separate files (#7357)

## [1.7.0] - 2025-11-10

* feat: make validator startup more resilient (#7342)

## [1.6.0] - 2025-11-06

* feat(validator): record reorg logs (#7238)
* feat: add metric for observed block height of checkpoints (#7146)
* feat: added fallback to starknet providers (#6537)
* feat: revert metric (#7196)
* feat: validator overwrite and log any checkpoints that don't match its current in-memory version (#6500)
* fix: validator count fetching upon startup is retried (#6470)
* refactor: Move tests into a separate file to simplify code navigation (#7126)
