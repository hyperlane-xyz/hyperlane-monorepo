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

Regression coverage now also confirms malformed `AggregateError.errors` payloads (spoofed boxed strings and `String.prototype` impostors) remain ignored under combined `message`+`cause` accessor failures.

Regression coverage now also confirms malformed `AggregateError.cause` payloads (spoofed boxed strings and `String.prototype` impostors) remain ignored under combined `message`+`errors` accessor failures.

Regression coverage now also confirms same-realm and cross-realm boxed-string `AggregateError.cause` payloads remain detectable/ignorable under combined `message`+`errors` accessor failures both with and without hostile `Symbol.toStringTag` accessors.

Runtime-unavailable extraction now also traverses `errors` payloads on non-`AggregateError` `Error` instances, with regression coverage for runtime/non-runtime and hostile-accessor top-level `Error` wrappers.

Regression coverage now also confirms top-level `Error` wrappers preserve detect/ignore behavior when `errors` or `cause` accessors throw, and malformed boxed-string impostor `Error.errors` payloads remain ignored under combined `message`+`cause` accessor failures.

Regression coverage now also confirms same-realm and cross-realm boxed-string top-level `Error.errors` payloads remain detectable/ignorable under combined `message`+`cause` accessor failures with and without hostile `Symbol.toStringTag` accessors, while coercible spoofed boxed-string `Error.errors` payloads remain ignored.

Regression coverage now also confirms same-realm and cross-realm boxed-string top-level `Error.cause` payloads remain detectable/ignorable under combined `message`+`errors` accessor failures with and without hostile `Symbol.toStringTag` accessors, while malformed (`coercible spoofed`, `uncoercible spoofed`, and `String.prototype` impostor) top-level `Error.cause` payloads remain ignored.

Regression coverage now also confirms malformed top-level `Error.cause` payloads (coercible/uncoercible spoofed boxed strings and `String.prototype` impostors) do not mask runtime/non-runtime outcomes from top-level `Error.errors` fallback payloads.

Regression coverage now also confirms top-level `Error.errors` payloads (same-realm/cross-realm boxed strings, hostile `toStringTag` wrappers, and malformed spoofed payloads) remain detectable/ignorable when top-level `Error.cause` accessors throw.

Regression coverage now also confirms top-level `Error.errors` payloads remain detectable/ignorable under `cause` accessor failures for cross-realm hostile boxed strings, while coercible spoofed and `String.prototype` impostor `Error.errors` payloads remain ignored.

Regression coverage now also confirms scalar string top-level `Error.errors` payloads remain detectable/ignorable under both `cause` accessor failures and combined `message`+`cause` accessor failures.

Regression coverage now also confirms scalar string `cause` payloads on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable when `errors` accessors throw, including combined `message`+`errors` accessor-failure paths.

Regression coverage now also confirms scalar string `cause` payloads on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable when only `message` accessors throw.

Regression coverage now also confirms runtime/non-runtime `message` fields on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable when both `cause` and `errors` accessors throw.

Regression coverage now also confirms boxed-string and hostile cross-realm boxed-string `message` fields on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable when both `cause` and `errors` accessors throw.

Regression coverage now also confirms non-hostile cross-realm boxed-string `message` fields on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable under combined `cause`+`errors` accessor failures, while malformed spoofed and `String.prototype` impostor message payloads remain ignored.

Regression coverage now also confirms hostile same-realm boxed-string `message` fields on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable under combined `cause`+`errors` accessor failures.

Regression coverage now also confirms runtime/non-runtime `name` fallback payloads on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable when `message`, `cause`, and `errors` accessors all throw.

Regression coverage now also confirms boxed-string (including hostile cross-realm boxed-string) `name` fallback payloads on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable under combined `message`+`cause`+`errors` accessor failures, while coercible spoofed boxed-string `name` payloads remain ignored.

Regression coverage now also confirms non-hostile cross-realm boxed-string `name` fallback payloads on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable under combined `message`+`cause`+`errors` accessor failures, while uncoercible spoofed and `String.prototype` impostor `name` payloads remain ignored.

Regression coverage now also confirms scalar/boxed-string (including hostile cross-realm boxed-string) `constructor.name` fallback payloads on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable under combined `message`+`name`+`cause`+`errors` accessor failures, while coercible/uncoercible spoofed and `String.prototype` impostor `constructor.name` payloads remain ignored.

Regression coverage now also confirms non-hostile cross-realm boxed-string `constructor.name` fallback payloads on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable under combined `message`+`name`+`cause`+`errors` accessor failures.

Regression coverage now also confirms same-realm boxed-string `constructor.name` fallback payloads remain detectable/ignorable even when boxed-string `Symbol.toStringTag` accessors throw under combined `message`+`name`+`cause`+`errors` accessor failures for both `AggregateError` and top-level `Error` wrappers.

Regression coverage now also confirms whitespace-trimmed scalar `constructor.name` fallback payloads on both `AggregateError` and top-level `Error` wrappers remain detectable/ignorable under combined `message`+`name`+`cause`+`errors` accessor failures.

Regression coverage now also confirms whitespace-only `name` payloads on both `AggregateError` and top-level `Error` wrappers are treated as non-informative, allowing runtime/non-runtime `constructor.name` fallback payloads to remain detectable/ignorable under combined `message`+`cause`+`errors` accessor failures.

Regression coverage now also confirms runtime/non-runtime `cause` and `errors` fallback payloads remain detectable/ignorable for both `AggregateError` and top-level `Error` wrappers even when `message`, `name`, and `constructor` accessors all throw.

Regression coverage now also confirms whitespace-trimmed string `cause` and `errors` fallback payloads remain detectable/ignorable for both `AggregateError` and top-level `Error` wrappers under the same hostile `message`+`name`+`constructor` accessor-failure permutations.

Regression coverage now also confirms structural `getErrorMessage` fallbacks (`JSON.stringify`, `inspect`, `Object.prototype.toString`, and the final unprintable placeholder path) remain non-crashing and runtime-signal-safe for both `AggregateError` and top-level `Error` wrappers under fully hostile `message`+`name`+`constructor`+`cause`+`errors` accessor failures.

`getErrorMessage` now also treats non-string `JSON.stringify` results (for example `toJSON` returning `undefined`) as non-informative and falls through to `inspect`/`Object.prototype.toString` fallbacks, with regression coverage proving runtime-unavailable signals are still detectable under fully hostile wrapper accessors.

Regression coverage now also confirms `toJSON`-returns-`undefined` paths continue through `Object.prototype.toString` and final placeholder fallbacks (not just `inspect`) for both matcher and formatter code paths, including runtime/non-runtime wrapper detection guarantees for fully hostile accessor permutations.

`getErrorMessage` now also treats whitespace-only `inspect(...)` output as non-informative, continuing to `Object.prototype.toString` fallback so structural runtime signals are not masked by blank custom inspect implementations.

`getErrorMessage` now also treats `JSON.stringify(...) === "null"` as non-informative in object-formatting fallbacks, allowing `inspect`/`Object.prototype.toString` to surface runtime signals instead of returning a generic `null` string.

`getErrorMessage` now also treats generic inspect placeholders (`{}`, `[]`, `null`, `undefined`) as non-informative, falling through to `Object.prototype.toString` so runtime signatures encoded in structural tags are not masked by empty inspect output.

Inspect-placeholder filtering now also covers bracketed placeholders (`[Object]`, `[Array]`), with regression coverage confirming matcher/formatter paths still fall through to `Object.prototype.toString` for runtime and non-runtime structural signal handling.

Inspect-placeholder filtering now also normalizes case and covers object-tag placeholders such as `[object Object]`/`[object Array]`, preventing these inert representations from masking runtime signals carried in `Object.prototype.toString` fallbacks.

Regression coverage now also confirms uppercase object-tag inspect placeholders (for example `[OBJECT OBJECT]`) are treated as non-informative and still fall through to tag-sensitive `Object.prototype.toString` fallback handling.

`getErrorMessage` now also treats JSON structural placeholders (`{}`, `[]`) as non-informative so they no longer short-circuit tag-sensitive fallback extraction.

Inspect-placeholder filtering coverage now also explicitly includes array placeholder variants (`[Array]` and `[object Array]`) to ensure they cannot mask runtime signals carried by `Object.prototype.toString` fallbacks.

JSON fallback handling now also treats quoted structural placeholders (for example `"{}"`, `"[]"`, or `"[Object]"` payload strings) as non-informative when they normalize to inert placeholders, preserving downstream inspect/toString runtime-signal extraction.

Inspect fallback handling now also treats quoted placeholder strings (for example `"{}"` and `"[Array]"`) as non-informative, so custom inspect implementations cannot mask runtime signals that should be surfaced by `Object.prototype.toString`.

Quoted object-tag placeholder variants (for example `"[object Object]"` and `"[object Array]"`) are now also covered across both JSON and inspect fallback paths, ensuring these inert serialized forms cannot short-circuit runtime-signal extraction.

Single-quoted placeholder strings (for example `'[Object]'` and `'[object Object]'`) are now also normalized as non-informative placeholder forms across JSON/inspect fallback handling.

Mixed quote-wrapper placeholder strings (for example `"'[Object]'"` and `"'[object Object]'"`) are now also covered so repeated quote wrapping cannot bypass placeholder filtering.

Mixed quote-wrapper object-tag array placeholders (for example `"'[object Array]'"`) are now also covered across JSON and inspect fallback paths.

Single-quoted object-tag array placeholders (for example `'[object Array]'`) are now also covered across JSON and inspect fallback paths.

Single-quoted object-tag (`'[object Object]'`) and single-quoted bracketed-array (`'[Array]'`) placeholder variants are now also covered across JSON/inspect fallback paths.

JSON-escaped single-quoted placeholder payloads (for example `"'[object Object]'"` and `"'[Array]'"`) are now also covered so nested quote-wrapping cannot bypass placeholder filtering.

Lowercase bracketed placeholder variants (`[object]`, `[array]`) are now also covered across JSON/inspect fallback paths.

Uppercase bracketed placeholder variants (`[OBJECT]`, `[ARRAY]`) are now also covered across JSON/inspect fallback paths.

Mixed-case bracketed placeholder variants (for example `[oBjEcT]` and `[aRrAy]`) are now also covered across JSON/inspect fallback paths.

When `JSON.stringify` and `inspect` are both non-informative, `getErrorMessage` now also considers `String(error)` before `Object.prototype.toString`, while still treating placeholder-like string outputs as non-informative.

`String(error)` fallback handling also treats bare `":"` outputs (from hostile `Error` wrappers with inaccessible name/message fields) as non-informative so diagnostics can continue to `Object.prototype.toString`.

Regression coverage also now confirms mixed-quoted placeholder outputs from `String(error)` are treated as non-informative and do not block `Object.prototype.toString` fallback behavior.

Regression coverage also now confirms uppercase bracketed placeholder outputs from `String(error)` are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms lowercase bracketed placeholder outputs from `String(error)` are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms bare-colon `String(error)` outputs are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms quoted bracketed placeholder outputs from `String(error)` (for example `"[Array]"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms object-tag placeholder outputs from `String(error)` (for example `[object Array]`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms single-quoted object-tag placeholder outputs from `String(error)` (for example `'[object Array]'`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms mixed-quoted object-tag placeholder outputs from `String(error)` (for example `"'[object Array]'"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms mixed-case object-tag placeholder outputs from `String(error)` (for example `[oBjEcT aRrAy]`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms uppercase object-tag placeholder outputs from `String(error)` (for example `[OBJECT ARRAY]`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms lowercase object-tag placeholder outputs from `String(error)` (for example `[object array]`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms quoted object-tag placeholder outputs from `String(error)` (for example `"[object Array]"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms object-tag object placeholder outputs from `String(error)` (for example `[object object]`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms single-quoted object-tag object placeholder outputs from `String(error)` (for example `'[object Object]'`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms mixed-quoted object-tag object placeholder outputs from `String(error)` (for example `"'[object Object]'"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms uppercase object-tag object placeholder outputs from `String(error)` (for example `[OBJECT OBJECT]`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms mixed-case object-tag object placeholder outputs from `String(error)` (for example `[oBjEcT oBjEcT]`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms quoted object-tag object placeholder outputs from `String(error)` (for example `"[object Object]"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms json-escaped quoted object-tag object placeholder outputs from `String(error)` (for example `\"[object Object]\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms json-escaped single-quoted object-tag object placeholder outputs from `String(error)` (for example `\'[object Object]\'`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms json-escaped mixed-quoted object-tag object placeholder outputs from `String(error)` (for example `\"'[object Object]'\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms json-escaped quoted object-tag placeholder outputs from `String(error)` (for example `\"[object Array]\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms json-escaped single-quoted and mixed-quoted object-tag placeholder outputs from `String(error)` (for example `\'[object Array]\'` and `\"'[object Array]'\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

`String(error)` placeholder normalization now also handles multi-escaped quote wrappers (for example `\\\"[object Array]\\\"`) so doubly escaped placeholder outputs are treated as non-informative and still fall through to `Object.prototype.toString`.

Regression coverage also now confirms double-escaped quoted object-tag object placeholder outputs from `String(error)` (for example `\\\"[object Object]\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms double-escaped single-quoted and mixed-quoted object-tag/object-tag-object placeholder outputs from `String(error)` (for example `\\'[object Array]\\'`, `\\\"'[object Array]'\\\"`, `\\'[object Object]\\'`, and `\\\"'[object Object]'\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms double-escaped quoted/single-quoted/mixed-quoted bracketed placeholder outputs from `String(error)` (for example `\\\"[Array]\\\"`, `\\'[Array]\\'`, and `\\\"'[Array]'\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms double-escaped uppercase object-tag/object-tag-object placeholder outputs from `String(error)` (for example `\\\"[OBJECT ARRAY]\\\"` and `\\\"[OBJECT OBJECT]\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms double-escaped mixed-case and lowercase object-tag/object-tag-object placeholder outputs from `String(error)` (for example `\\\"[oBjEcT aRrAy]\\\"`, `\\\"[object array]\\\"`, `\\\"[oBjEcT oBjEcT]\\\"`, and `\\\"[object object]\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms triple-escaped quoted object-tag/object-tag-object placeholder outputs from `String(error)` (for example `\\\\\\\"[object Array]\\\\\\\"` and `\\\\\\\"[object Object]\\\\\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage also now confirms triple-escaped single-quoted and mixed-quoted object-tag/object-tag-object placeholder outputs from `String(error)` (for example `\\\\\\'[object Array]\\\\\\'`, `\\\\\\\"'[object Array]'\\\\\\\"`, `\\\\\\'[object Object]\\\\\\'`, and `\\\\\\\"'[object Object]'\\\\\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage now also confirms primitive throw values are handled safely: top-level string primitives still match runtime-unavailable signatures, non-string primitives remain ignored for matcher activation, and formatter output for `undefined`/`null`/scalar/symbol primitive startup errors uses the final `String(error)` fallback.

Regression coverage now also confirms triple-escaped quoted/single-quoted/mixed-quoted bracketed placeholder outputs from `String(error)` (for example `\\\\\\\"[Array]\\\\\\\"`, `\\\\\\'[Array]\\\\\\'`, and `\\\\\\\"'[Array]'\\\\\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage now also confirms triple-escaped uppercase/mixed-case/lowercase bracketed placeholder outputs from `String(error)` (for example `\\\\\\\"[ARRAY]\\\\\\\"`, `\\\\\\\"[aRrAy]\\\\\\\"`, and `\\\\\\\"[array]\\\\\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage now also confirms triple-escaped bracketed-object placeholder outputs from `String(error)` (for example `\\\\\\\"[Object]\\\\\\\"`, `\\\\\\\"[OBJECT]\\\\\\\"`, and `\\\\\\\"[object]\\\\\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage now also confirms triple-escaped single-quoted/mixed-quoted/mixed-case bracketed-object placeholder outputs from `String(error)` (for example `\\\\\\'[Object]\\\\\\'`, `\\\\\\\"'[Object]'\\\\\\\"`, and `\\\\\\\"[oBjEcT]\\\\\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage now also confirms double-escaped quoted/single-quoted/mixed-quoted bracketed-object placeholder outputs from `String(error)` (for example `\\\"[Object]\\\"`, `\\'[Object]\\'`, and `\\\"'[Object]'\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage now also confirms double-escaped uppercase/mixed-case/lowercase bracketed-object placeholder outputs from `String(error)` (for example `\\\"[OBJECT]\\\"`, `\\\"[oBjEcT]\\\"`, and `\\\"[object]\\\"`) are treated as non-informative and continue through to `Object.prototype.toString`.

Regression coverage now also confirms json-escaped quoted/single-quoted/mixed-quoted bracketed-object placeholder outputs from `String(error)` (for example `\"[Object]\"`, `\'[Object]\'`, and `\"'[Object]'\"`) are treated as non-informative and continue through to `Object.prototype.toString`.
