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

Formatter fallback handling was also hardened for `Error` instances whose `message` accessors throw, preserving non-crashing startup diagnostics.

Regression coverage was expanded for case-and-whitespace normalized `ENOENT` codes so missing-binary hints remain stable across wrapper-transformed error metadata.

When `Error.message` access fails, startup formatting now falls back to the error name before structural serialization, improving readability for hostile error wrappers.

Blank-string `message` payloads are now treated as non-informative so formatter output can fall back to richer name/structured diagnostics.

If both message and name are blank on `Error` instances, formatter diagnostics now fall back to constructor names before structural serialization.

Regression coverage now includes hostile `Error` objects where constructor-name access throws after blank message/name values, ensuring non-crashing structural fallback output.

Runtime-unavailable extraction now guards `Error.message` reads the same way as wrapper objects, preventing matcher crashes when hostile Error accessors throw.

String non-emptiness checks in formatter/matcher extraction were consolidated, with regression coverage for whitespace-heavy `ENOENT` code normalization.

Matcher regression coverage now also confirms docker-runtime causes are still detected when top-level `Error` messages are whitespace-only.

Formatter and matcher message extraction now normalize non-empty strings by trimming surrounding whitespace, reducing noisy diagnostics from padded wrapper messages.

Matcher regression coverage also now confirms docker-runtime causes are still detected when top-level wrapper-object messages are whitespace-only.

Matcher regression coverage now also confirms docker-runtime causes are still detected when top-level wrapper-object `message` accessors throw.

Matcher regression coverage now also confirms docker-runtime signals are still detected when wrapper-object `cause` accessors throw but nested `errors` collections remain available.

Matcher regression coverage now also confirms docker-runtime signals are still detected when wrapper-object `errors` accessors throw but nested `cause` values remain available.

Matcher regression coverage now also covers `errors` payloads shaped as single error-like objects (not just arrays/maps/iterables), ensuring direct wrapper objects still trigger runtime-unavailable detection.

Nested extraction now also enqueues error-shaped `errors` wrapper objects directly, so runtime-unavailable signals in their nested `cause` chains are detected even when wrapper serialization is non-informative.

Regression coverage now also confirms error-shaped `errors` wrappers with blank top-level messages still detect runtime-unavailable signals via nested `cause` chains.

Regression coverage now also confirms error-shaped `errors` wrappers with non-string top-level messages still detect runtime-unavailable signals via nested `cause` chains.

Regression coverage now also confirms iterable wrappers with non-matching yielded entries still detect runtime-unavailable signals exposed via wrapper-level `cause` fallbacks.

Nested iterable wrapper traversal now also preserves wrapper-level `cause`/`errors` fallbacks after iterable value scans, so runtime-unavailable signals are still detected even when yielded values are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms map-wrapper `errors` payloads preserve wrapper-level `cause` fallbacks after map-value scans, even when map entries are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms array-wrapper `errors` payloads preserve wrapper-level `cause` fallbacks after array-entry scans, even when entries are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms set-wrapper `errors` payloads preserve wrapper-level `cause` fallbacks after set-entry scans, even when entries are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms generator-wrapper `errors` payloads preserve wrapper-level `cause` fallbacks after yielded-entry scans, even when yielded values are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms generator-wrapper `errors` payloads preserve wrapper-level nested `errors` fallbacks after yielded-entry scans, even when yielded values are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms map-wrapper `errors` payloads preserve wrapper-level nested `errors` fallbacks after map-value scans, even when map entries are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms array-wrapper `errors` payloads preserve wrapper-level nested `errors` fallbacks after array-entry scans, even when entries are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms set-wrapper `errors` payloads preserve wrapper-level nested `errors` fallbacks after set-entry scans, even when entries are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms iterable-wrapper `errors` payloads preserve wrapper-level nested `errors` fallbacks after yielded-entry scans, even when yielded entries are non-matching and wrapper formatting is non-informative.

Regression coverage now also confirms error-shaped wrapper `errors` payloads preserve nested `errors` fallbacks even when top-level wrapper messaging is non-informative.

Regression coverage now also confirms iterable-wrapper `errors` payloads with self-referential `errors` fields avoid re-enqueue loops while still detecting runtime-unavailable signals from wrapper-level `cause` fallbacks.

Regression coverage now also confirms map-wrapper `errors` payloads with self-referential `errors` fields avoid re-enqueue loops while still detecting runtime-unavailable signals from wrapper-level `cause` fallbacks.

Regression coverage now also confirms map-wrapper `errors` payloads still match runtime-unavailable signals when wrapper `cause` accessors throw but wrapper-level `errors` fallbacks remain available.

Regression coverage now also confirms array-wrapper `errors` payloads with self-referential `errors` fields avoid re-enqueue loops while still detecting runtime-unavailable signals from wrapper-level `cause` fallbacks.

Regression coverage now also confirms set-wrapper `errors` payloads still match runtime-unavailable signals when wrapper `cause` accessors throw but wrapper-level `errors` fallbacks remain available.

Nested wrapper-field extraction now always runs after map/array/iterable traversal attempts, so wrapper-level `cause`/`errors` fallbacks are preserved even when iterators throw.

Regression coverage now also confirms malformed iterable and map wrappers with fully throwing iterators still detect runtime-unavailable signals when only non-enumerable wrapper-level `errors` fallbacks are available.

Regression coverage now also confirms malformed array wrappers with throwing iterators still detect runtime-unavailable signals when only non-enumerable wrapper-level `errors` fallbacks are available.

Regression coverage now also confirms malformed set wrappers with throwing iterators still detect runtime-unavailable signals when only non-enumerable wrapper-level `errors` fallbacks are available.

Regression coverage now also confirms malformed generator wrappers with throwing iterators still detect runtime-unavailable signals when only non-enumerable wrapper-level `errors` fallbacks are available.

Regression coverage now also confirms generator-wrapper `errors` payloads with self-referential `errors` fields avoid re-enqueue loops while still detecting runtime-unavailable signals from wrapper-level `cause` fallbacks.

Regression coverage now also confirms generator-wrapper `errors` payloads still match runtime-unavailable signals when wrapper `cause` accessors throw but wrapper-level `errors` fallbacks remain available.

Nested wrapper-field extraction for map/array/iterable wrappers now prioritizes wrapper-level `cause`/`errors` fallback enqueueing ahead of entry scans, so runtime-unavailable wrapper signals are not starved by noisy collections that exhaust extraction limits.

Regression coverage now also confirms iterable wrappers with large non-matching entry sets still detect runtime-unavailable wrapper-level `cause` fallbacks under extraction-pressure scenarios.

Regression coverage now also confirms map, array, set, and generator wrappers with large non-matching entry sets still detect runtime-unavailable wrapper-level `cause` fallbacks under extraction-pressure scenarios.

Regression coverage now also confirms map, array, set, and generator wrappers with large non-matching entry sets still detect runtime-unavailable wrapper-level `errors` fallbacks under extraction-pressure scenarios.

Regression coverage now also confirms map, array, set, and generator wrappers with large non-matching entry sets still detect wrapper-level runtime-unavailable `cause` fallbacks when wrapper `errors` fields are self-referential.

Regression coverage now also confirms map, array, set, and generator wrappers with large non-matching entry sets still detect wrapper-level runtime-unavailable `errors` fallbacks when wrapper `cause` accessors throw.

Regression coverage now also confirms map, array, set, and generator wrappers with large non-matching entry sets still detect wrapper-level runtime-unavailable `cause` fallbacks when wrapper `errors` accessors throw.

Nested plain-object `errors` wrapper extraction now prioritizes wrapper-level fallback fields before object-value traversal, preserving runtime-unavailable signal detection under extraction-pressure scenarios.

Regression coverage now also confirms plain-object wrappers with large non-matching fields still detect runtime-unavailable wrapper-level `cause` and `errors` fallbacks under extraction pressure, including when wrapper `cause` accessors throw.

Regression coverage now also confirms plain-object wrappers with large non-matching fields still detect runtime-unavailable wrapper-level `cause` fallbacks when wrapper `errors` fields are self-referential or wrapper `errors` accessors throw.

Nested wrapper extraction now also preserves runtime-unavailable wrapper-level `message` fallback detection for noisy map, array, set, and iterable wrappers under extraction-pressure scenarios.

Regression coverage now also confirms noisy map/array/set/generator wrappers (and noisy plain-object wrappers) still detect runtime-unavailable wrapper-level `message` fallbacks under extraction pressure.

Regression coverage now also confirms noisy wrapper-level `message` fallbacks remain detectable when wrapper `cause` and `errors` accessors throw across map/array/set/generator and plain-object wrappers.

Error extraction now deduplicates repeated object references while traversing nested wrapper payloads, preventing extraction-budget starvation from duplicate references that can mask later runtime-unavailable signals.

Regression coverage now also confirms repeated-reference wrapper payloads still detect runtime-unavailable signals that appear after large duplicate object sequences.

Error extraction now also deduplicates repeated primitive values while traversing nested wrapper payloads, preventing extraction-budget starvation from duplicate scalar entries that can mask later runtime-unavailable signals.

Regression coverage now also confirms repeated-primitive wrapper payloads still detect runtime-unavailable signals that appear after large duplicate scalar sequences.

Regression coverage now also confirms malformed iterable and map wrappers with fully throwing iterators still detect runtime-unavailable non-enumerable wrapper-level `message` fallbacks, even when wrapper `cause` and `errors` accessors throw.

Regression coverage now also confirms malformed array, set, and generator wrappers with throwing iterators still detect runtime-unavailable non-enumerable wrapper-level `message` fallbacks, even when wrapper `cause` and `errors` accessors throw.

Nested error extraction now enqueues string-valued `errors` payloads directly, so runtime-unavailable signals carried as scalar nested error strings remain detectable.

Regression coverage now also confirms string-valued nested `errors` payloads match runtime-unavailable signals while non-runtime strings remain ignored.

Nested error extraction now also normalizes boxed string (`String`) nested `errors` payloads so runtime-unavailable scalar signals are preserved rather than iterated character-by-character.

Regression coverage now also confirms boxed string nested `errors` payloads match runtime-unavailable signals while non-runtime boxed strings remain ignored.

Regression coverage now also confirms string-valued `AggregateError.errors` payloads match runtime-unavailable signals while non-runtime scalar entries remain ignored.

Regression coverage now also confirms boxed-string-valued `AggregateError.errors` payloads match runtime-unavailable signals while non-runtime boxed-scalar entries remain ignored.

Runtime-unavailable extraction now also normalizes boxed-string throw values during queue traversal, preserving signal detection when non-Error payloads are thrown as `String` objects.

Regression coverage now also confirms boxed-string throw values match runtime-unavailable signals while non-runtime boxed-string throw values remain ignored.

Regression coverage now also confirms set-wrapper `errors` payloads with self-referential `errors` fields avoid re-enqueue loops while still detecting runtime-unavailable signals from wrapper-level `cause` fallbacks.

String normalization now also treats boxed-string (`String`) message/code payloads as first-class strings, preserving runtime-signal and ENOENT detection for wrapped scalar metadata.

Regression coverage now also confirms boxed-string wrapper `message` fields remain detectable under non-informative serialization, boxed-string non-runtime messages stay ignored, and boxed-string `code` values still trigger ENOENT install hints.

Boxed-string normalization now also handles cross-realm `String` objects (e.g., VM-context values), preventing character-wise iterable traversal from masking runtime-unavailable signals in wrapped scalar payloads.

Regression coverage now also confirms cross-realm boxed-string throw values and nested `errors` payloads match runtime-unavailable signals while non-runtime cross-realm boxed strings remain ignored, and cross-realm boxed `code`/`message` metadata still produces ENOENT hints plus trimmed startup diagnostics.

Boxed-string normalization now also handles spoofed `[object String]` payloads that throw during coercion, preventing matcher/formatter crashes when hostile wrappers masquerade as boxed strings.

Regression coverage now also confirms uncoercible spoofed boxed-string throw payloads and nested `errors` fields are handled safely, runtime causes remain detectable alongside spoofed nested payloads, spoofed boxed `code` values do not mis-trigger ENOENT hints, and spoofed boxed `message` values cleanly fall back to structured diagnostics.

Boxed-string normalization now uses `String.prototype.valueOf.call(...)` for boxed payload extraction, so only genuine boxed strings (including cross-realm values) are normalized while spoofed `[object String]` objects are ignored even when they return string-like coercions.

Regression coverage now also confirms coercible spoofed boxed-string throw payloads and nested `errors` fields do not trigger runtime-unavailable false positives, runtime `cause` fallback detection remains intact when coercible spoofed nested payloads are present, and coercible spoofed boxed `code`/`message` metadata still falls back to standard non-string diagnostic paths.

Boxed-string normalization now no longer depends on `toStringTag` checks, and instead verifies true boxed-string identity through `String.prototype.valueOf.call(...)`, preserving detection when hostile wrappers override or throw from `Symbol.toStringTag`.

Regression coverage now also confirms genuine boxed-string throw values plus boxed `code`/`message` metadata remain correctly normalized even when `Symbol.toStringTag` accessors throw.

Regression coverage now also confirms boxed-string-valued `AggregateError.errors` payloads remain detectable when `Symbol.toStringTag` accessors throw, while coercible spoofed boxed-string `AggregateError.errors` payloads stay ignored.

Regression coverage now also confirms boxed-string-valued wrapper `errors` fields remain detectable/ignorable under runtime/non-runtime signals even when boxed-string `Symbol.toStringTag` accessors throw.

Regression coverage now also confirms `String.prototype` impostor payloads (objects inheriting `String.prototype` without true boxed-string internals) are ignored for runtime/error-code matching, while wrapper-level runtime `cause` fallbacks remain detectable when such impostors are present.

Regression coverage now also confirms cross-realm boxed-string payloads remain detectable/ignorable across throw values, wrapper `errors`, `AggregateError.errors`, and formatter `code`/`message` extraction even when boxed-string `Symbol.toStringTag` accessors throw.

Regression coverage now also confirms cross-realm boxed-string-valued wrapper `errors` fields continue to detect runtime signals (and ignore non-runtime signals) when `Symbol.toStringTag` accessors throw.

Regression coverage now also confirms wrapper-level cross-realm boxed-string `message` fields remain detectable/ignorable under non-informative serialization, including hostile `Symbol.toStringTag` accessor failures.

Regression coverage now also confirms same-realm boxed-string wrapper `message` fields remain detectable/ignorable under non-informative serialization even when `Symbol.toStringTag` accessors throw.

Regression coverage now also confirms cross-realm boxed-string-valued `AggregateError.errors` payloads remain detectable/ignorable both with and without hostile `Symbol.toStringTag` accessors.

Regression coverage now also confirms boxed-string-valued wrapper `cause` fields (same-realm and cross-realm, with and without hostile `Symbol.toStringTag` accessors) remain detectable/ignorable for runtime-unavailable matching.

Regression coverage now also confirms spoofed boxed-string and `String.prototype` impostor wrapper `cause` payloads are ignored for runtime matching, while wrapper-level runtime `errors` fallbacks remain detectable when those malformed `cause` payloads are present.

Regression coverage now also confirms boxed-string-valued `Error.cause` payloads (same-realm and cross-realm, including hostile `Symbol.toStringTag` accessors) remain detectable/ignorable for runtime-unavailable matching.

Regression coverage now also confirms cross-realm boxed-string-valued `Error.cause` payloads remain detectable/ignorable both with and without hostile `Symbol.toStringTag` accessors.

Regression coverage now also confirms spoofed boxed-string and `String.prototype` impostor top-level `Error.cause` payloads are ignored for runtime matching.

Regression coverage now also confirms `AggregateError.errors` runtime signals remain detectable even when `AggregateError.cause` carries spoofed boxed-string or `String.prototype` impostor payloads.

Regression coverage now also confirms spoofed boxed-string and `String.prototype` impostor `AggregateError.cause` payloads remain ignored when `AggregateError.errors` only contains non-runtime noise.

Regression coverage now also confirms boxed-string-valued `AggregateError.cause` payloads (same-realm and cross-realm, with hostile `Symbol.toStringTag` accessors) remain detectable/ignorable when `AggregateError.errors` contains only non-runtime values.

Regression coverage now also confirms boxed-string-valued `AggregateError.cause` payloads (same-realm and cross-realm, without hostile `Symbol.toStringTag` accessors) remain detectable/ignorable when `AggregateError.errors` contains only non-runtime values.

Regression coverage now also confirms `AggregateError` instances remain detectable/ignorable when hostile `cause` or `errors` accessors throw, as long as the remaining field still carries runtime/non-runtime signals.

Regression coverage now also confirms `AggregateError` runtime matching remains stable when `message` accessors throw and detection must rely on `cause`/`errors` payloads.

Regression coverage now also confirms `AggregateError` runtime matching remains stable when `message` plus `cause` or `errors` accessors throw simultaneously, as long as the remaining field still carries runtime/non-runtime signals.

Regression coverage now also confirms same-realm and cross-realm boxed-string `AggregateError.errors` payloads (including hostile `Symbol.toStringTag` accessors) remain detectable/ignorable even when both `AggregateError.message` and `AggregateError.cause` accessors throw.

Regression coverage now also confirms same-realm and cross-realm boxed-string `AggregateError.cause` payloads (including hostile `Symbol.toStringTag` accessors) remain detectable/ignorable even when both `AggregateError.message` and `AggregateError.errors` accessors throw.

Regression coverage now also confirms same-realm and cross-realm boxed-string `AggregateError.errors` payloads remain detectable/ignorable under combined `message`+`cause` accessor failures both with and without hostile `Symbol.toStringTag` accessors.
