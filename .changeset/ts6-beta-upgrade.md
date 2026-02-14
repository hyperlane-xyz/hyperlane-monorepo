---
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/cli": patch
"@hyperlane-xyz/utils": patch
"@hyperlane-xyz/cosmos-sdk": patch
"@hyperlane-xyz/aleo-sdk": patch
"@hyperlane-xyz/radix-sdk": patch
"@hyperlane-xyz/widgets": patch
"@hyperlane-xyz/deploy-sdk": patch
"@hyperlane-xyz/core": patch
"@hyperlane-xyz/starknet-core": patch
"@hyperlane-xyz/rebalancer": patch
"@hyperlane-xyz/tron-sdk": patch
"@hyperlane-xyz/cosmos-types": patch
---

The monorepo TypeScript toolchain was upgraded to 6.0.0-beta.

Shared TypeScript configs were updated to explicitly include `node` and `mocha` ambient types for TS6 compatibility, and package type dependencies were aligned accordingly.

TS6 compatibility fixes were applied in lint configuration and tron-sdk test imports to keep build and lint pipelines green.

Test execution ergonomics were also improved by adding a local-Anvil fallback for rebalancer simulation tests (when Docker is unavailable), and by making infra registry resolution fallback to the packaged registry data when no local registry clone is present.

The root lint command was also hardened to retry turbo lint serially only on OOM (exit code 137), while preserving normal failure behavior for real lint errors.

The local-Anvil fallback reliability was further improved by handling additional docker socket connection error patterns and hardening local process shutdown edge cases.

Fallback diagnostics were also hardened to handle nested and wrapped runtime errors (including cross-platform Docker daemon failure formats) and to produce clearer messages for non-standard error payloads.

Runtime-unavailable detection coverage was further expanded to include Podman socket failure signatures and iterable/map/object nested error collection formats emitted by container tooling wrappers.

Socket-runtime detection coverage was also expanded for missing-socket daemon errors (`ENOENT` and `no such file or directory` formats) across both Docker and Podman paths.

Windows named-pipe runtime-unavailable detection was further expanded to include Docker Desktop `dockerDesktopLinuxEngine` pipe failure signatures.

Windows matcher coverage was additionally expanded for URL-encoded named-pipe path signatures emitted by Docker daemon connection errors.

Windows named-pipe detection was further broadened to include `dockerDesktopEngine` signatures across npipe, slash/backslash path, and URL-encoded forms.

Windows named-pipe matcher coverage was also expanded for URL-encoded backslash pipe signatures, and matcher construction was refactored to derive Windows pipe patterns from a shared engine list for easier maintenance.

Matcher precision was also tightened with regression coverage that rejects unknown Windows named-pipe engine signatures, reducing false-positive fallback activation.

Nested runtime-error traversal was additionally hardened to tolerate malformed iterable wrappers (non-callable or throwing iterators), with safe fallback to object-value traversal.

Nested iterable traversal is now also bounded to guard against unbounded iterator payloads in wrapper errors.

Nested error-collection traversal was further hardened to tolerate throwing map iterators and throwing object accessors without crashing matcher evaluation.

Extracted-error queue traversal was also refactored to index-based iteration to avoid repeated queue shifting during nested error scans.

Bounded traversal semantics were regression-tested to ensure late iterable runtime signals beyond the extraction cap are intentionally ignored for safety.

Runtime-fallback docs were updated to explicitly describe the bounded nested-error traversal behavior and its safety trade-off.

Map-iterator fallback handling was corrected to avoid false positives from map keys when values iterators fail.

Error-message extraction was hardened for proxy wrappers that throw on `message`/`cause` access, preventing matcher crashes.

Regression coverage was added for the final formatting fallback path when both JSON serialization and object inspection throw.

Local-anvil startup error formatting was further hardened to avoid crashes when `code` reads or `toStringTag` formatting throw, with a stable placeholder fallback for fully unprintable error values.

Regression coverage was expanded for wrapper errors with throwing `code` accessors to ensure startup formatting still returns actionable fallback messages.

Regression coverage was also added to guarantee the ENOENT install hint still wins when wrapper errors throw on `message` access.

Safe object-property access for formatter and matcher helpers was centralized to keep hostile wrapper handling consistent across `message`/`code`/`cause`/`errors` reads.

Local-anvil startup formatting now treats case-variant `ENOENT` code values equivalently, preserving missing-binary install guidance for wrapper-normalized error codes.
