#!/usr/bin/env python3
"""Generate Zig Prometheus descriptors from the canonical Rust registrations.

This is a bounded Rust-expression reader, not a general Rust parser: it scans
identifier boundaries outside strings/comments, extracts balanced call
arguments, and only accepts literal/const string, label-array, and numeric
bucket grammars used by the inputs below. Run from the repository root after
changing canonical metrics.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / "zig/src/ops/metrics_schema.zig"
MANIFEST = ROOT / "zig/src/ops/tools/metrics-source-manifest.json"

SHARED = [
    "rust/main/hyperlane-base/src/metrics/core.rs",
    "rust/main/hyperlane-base/src/metrics/agent_metrics.rs",
    "rust/main/hyperlane-base/src/metrics/runtime_metrics.rs",
]
LAZY = [
    "rust/main/hyperlane-base/src/contract_sync/metrics.rs",
    "rust/main/hyperlane-base/src/contract_sync/cursors/metrics.rs",
    "rust/main/hyperlane-base/src/metrics/provider.rs",
    "rust/main/hyperlane-base/src/metrics/json_rpc_client.rs",
    "rust/main/hyperlane-base/src/metrics/cache.rs",
]
RELAYER = [
    "rust/main/lander/src/dispatcher/metrics.rs",
    "rust/main/agents/relayer/src/msg/db_loader.rs",
    "rust/main/agents/relayer/src/scraper_websocket.rs",
    "rust/main/agents/relayer/src/msg/runtime_denylist.rs",
    "rust/main/agents/relayer/src/relay_api/metrics.rs",
]
SCRAPER = [
    "rust/main/agents/scraper/src/agent.rs",
    "rust/main/agents/scraper/src/reconciliation/metrics.rs",
]
VALIDATOR = ["rust/main/agents/validator/src/validator.rs"]
ALL = sorted(set(SHARED + LAZY + RELAYER + SCRAPER + VALIDATOR + [
    "rust/main/ethers-prometheus/src/middleware/mod.rs",
    "rust/main/hyperlane-metric/src/prometheus_metric.rs",
    "rust/main/hyperlane-base/src/cache/metered_cache.rs",
    "rust/main/Cargo.toml",
    "rust/main/hyperlane-base/Cargo.toml",
]))

FACTORIES = {
    "new_int_gauge": "int_gauge",
    "new_gauge": "gauge",
    "new_int_counter": "int_counter",
    "new_counter": "counter",
    "new_histogram": "histogram",
}
REGISTRIES = {
    "register_int_gauge_vec_with_registry": "int_gauge",
    "register_gauge_vec_with_registry": "gauge",
    "register_int_counter_vec_with_registry": "int_counter",
    "register_counter_vec_with_registry": "counter",
    "register_histogram_vec_with_registry": "histogram",
}


def source_without_tests(path: Path) -> str:
    return strip_test_items(path.read_text())


def strip_test_items(text: str) -> str:
    """Remove attributed test items, not all code after a test-only import.

    Covers the bounded source grammar used here: imports/constants, methods,
    fields and modules. Keep offsets/newlines for diagnostics and ignore test
    attributes inside comments or strings. Production items after a test item
    must remain visible to the descriptor reader.
    """
    hidden = bytearray(len(text))
    for start, end in outside_masks(text):
        hidden[start:end] = b"\x01" * (end - start)
    excluded: list[tuple[int, int]] = []
    previous_end = 0
    for match in re.finditer(r"#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]", text):
        if match.start() < previous_end or hidden[match.start()]:
            continue
        start = match.start()
        pos = match.end()
        # Fields terminate at a top-level comma; generic type arguments may
        # contain commas themselves. Other item bodies are bounded by braces.
        field = re.match(r"\s*(?:pub(?:\([^)]*\))?\s+)?[A-Za-z_]\w*\s*:", text[pos:]) is not None
        stack: list[str] = []
        body = False
        end = None
        for i in range(pos, len(text)):
            if hidden[i]:
                continue
            char = text[i]
            if char in "([{":
                if char == "{" and not stack:
                    body = True
                stack.append(char)
            elif field and char == "<":
                stack.append(char)
            elif char in ")]}":
                expected = {")": "(", "]": "[", "}": "{"}[char]
                if stack and stack[-1] == expected:
                    stack.pop()
                    if char == "}" and body and not stack:
                        end = i + 1
                        break
            elif field and char == ">":
                if stack and stack[-1] == "<":
                    stack.pop()
            elif not stack and (char == ";" or (field and char == ",")):
                end = i + 1
                break
        if end is None:
            raise ValueError("Unterminated #[cfg(test)] item")
        excluded.append((start, end))
        previous_end = end
    output = list(text)
    for start, end in excluded:
        for i in range(start, end):
            if output[i] != "\n":
                output[i] = " "
    return "".join(output)


def outside_masks(text: str) -> list[tuple[int, int]]:
    """Ranges that are comments, strings, chars, or raw identifiers' contents."""
    masks: list[tuple[int, int]] = []
    i = 0
    while i < len(text):
        if text.startswith("//", i):
            end = text.find("\n", i)
            end = len(text) if end < 0 else end
            masks.append((i, end))
            i = end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            end = len(text) if end < 0 else end + 2
            masks.append((i, end))
            i = end
        elif text[i] == '"':
            start = i
            i += 1
            while i < len(text):
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == '"':
                    i += 1
                    break
                i += 1
            masks.append((start, i))
        elif text[i] == "'":
            # Rust lifetimes are not char literals; only quote followed by an
            # escape/plain char and closing quote is masked.
            j = i + 1
            if j < len(text) and text[j] == "\\":
                j += 2
            elif j < len(text):
                j += 1
            if j < len(text) and text[j] == "'":
                masks.append((i, j + 1))
                i = j + 1
            else:
                i += 1
        else:
            i += 1
    return masks


def masked(position: int, masks: list[tuple[int, int]]) -> bool:
    return any(start <= position < end for start, end in masks)


def call_ranges(text: str, identifier: str, bang: bool = False) -> list[tuple[int, int, str]]:
    masks = outside_masks(text)
    suffix = "!" if bang else ""
    pattern = re.compile(r"(?<![\w])" + re.escape(identifier + suffix) + r"(?![\w])")
    result: list[tuple[int, int, str]] = []
    for match in pattern.finditer(text):
        pos = match.end()
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text) or text[pos] != "(":
            continue
        if masked(match.start(), masks):
            continue
        depth = 0
        for end in range(pos, len(text)):
            if masked(end, masks):
                continue
            char = text[end]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    result.append((match.start(), end + 1, text[pos + 1 : end]))
                    break
    return result


def split_args(args: str) -> list[str]:
    masks = outside_masks(args)
    output: list[str] = []
    start = 0
    depth = 0
    for i, char in enumerate(args):
        if masked(i, masks):
            continue
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "," and depth == 0:
            output.append(args[start:i].strip())
            start = i + 1
    if args[start:].strip():
        output.append(args[start:].strip())
    return output


def constants(text: str) -> dict[str, str]:
    found = re.findall(r"\bconst\s+([A-Z][A-Z0-9_]+)\s*:\s*&str\s*=\s*(\"(?:\\.|[^\"\\])*\")", text)
    return {name: json.loads(value) for name, value in found}


def parse_string(argument: str, consts: dict[str, str], namespace: str | None = "hyperlane") -> str:
    argument = argument.strip()
    if argument.startswith('"'):
        value = json.loads(argument)
    elif argument in consts:
        value = consts[argument]
    else:
        nested = re.search(r"\b(?:namespaced!?)\(\s*(\"(?:\\.|[^\"\\])*\")\s*\)", argument)
        if not nested:
            raise ValueError(f"unsupported string expression: {argument!r}")
        value = json.loads(nested.group(1))
    if argument.startswith('"') or argument in consts:
        return f"{namespace}_{value}" if namespace is not None and not value.startswith("hyperlane_") else value
    return value


def parse_labels(argument: str, array_consts: dict[str, list[str]] | None = None) -> list[str]:
    argument = argument.strip()
    if array_consts and argument in array_consts:
        return array_consts[argument]
    if not argument.startswith("&["):
        raise ValueError(f"unsupported label expression: {argument!r}")
    body = argument[2:].removesuffix("]").strip()
    if not body:
        return []
    return [json.loads(part.strip()) for part in split_args(body) if part.strip()]


def parse_buckets(argument: str) -> list[float]:
    argument = argument.strip()
    if not argument.startswith("vec!["):
        raise ValueError(f"unsupported bucket expression: {argument!r}")
    body = argument[5:].removesuffix("]").strip()
    if not body:
        return []
    return [float(part.strip().removesuffix(".0")) for part in split_args(body) if part.strip()]


def descriptor(name: str, help_text: str, kind: str, labels: list[str], buckets: list[float], source: str) -> dict:
    if kind == "counter" and not name.endswith("_total") and not name.endswith("_count") and not name.endswith("_seconds"):
        # Preserve Rust source names exactly; this assertion catches accidental suffix normalization.
        pass
    return {"name": name, "help": help_text, "kind": kind, "labels": labels, "buckets": buckets, "source": source, "base_labels": False}


def array_constants(text: str) -> dict[str, list[str]]:
    found = re.findall(r"\bconst\s+([A-Z][A-Z0-9_]+)\s*:\s*&\[&str\]\s*=\s*(&\s*\[[^\]]*\])", text)
    return {name: parse_labels(value) for name, value in found}

def parse_file(relative: str, group: str) -> list[dict]:
    path = ROOT / relative
    text = source_without_tests(path)
    consts = constants(text)
    arrays = array_constants(text)
    dependencies = {
        "rust/main/hyperlane-base/src/metrics/provider.rs": "rust/main/ethers-prometheus/src/middleware/mod.rs",
        "rust/main/hyperlane-base/src/metrics/json_rpc_client.rs": "rust/main/hyperlane-metric/src/prometheus_metric.rs",
        "rust/main/hyperlane-base/src/metrics/cache.rs": "rust/main/hyperlane-base/src/cache/metered_cache.rs",
    }
    if relative in dependencies:
        dependency = source_without_tests(ROOT / dependencies[relative])
        consts.update(constants(dependency))
        arrays.update(array_constants(dependency))
    output: list[dict] = []
    namespace = "hyperlane_lander" if "/lander/" in relative else "hyperlane"

    for identifier, kind in FACTORIES.items():
        for _, _, args_text in call_ranges(text, identifier):
            args = split_args(args_text)
            # Skip Rust method declarations such as `fn new_gauge(&self, ...)`.
            if args and args[0] == "&self":
                continue
            if len(args) < 3:
                raise ValueError(f"{relative}: {identifier} needs name/help/labels: {args!r}")
            name = parse_string(args[0], consts, "hyperlane")
            help_text = parse_string(args[1], consts, None)
            labels = parse_labels(args[2], arrays) if args[2] in arrays else parse_labels(args[2])
            buckets = parse_buckets(args[3]) if kind == "histogram" and len(args) > 3 else []
            item = descriptor(name, help_text, kind, labels, buckets, relative)
            item["base_labels"] = True
            output.append(item)

    for identifier, kind in REGISTRIES.items():
        for _, _, body in call_ranges(text, identifier, bang=True):
            if "metric_name" in body:
                # Generic factory implementation, not a concrete registration.
                continue
            namespaced = re.search(r"\bnamespaced!?\(\s*\"((?:\\.|[^\"\\])*)\"", body)
            literal = re.search(r"\bopts!\(\s*\"((?:\\.|[^\"\\])*)\"\s*,\s*\"((?:\\.|[^\"\\])*)\"", body)
            if namespaced:
                name = namespace + "_" + json.loads('"' + namespaced.group(1) + '"')
                after = body[namespaced.end():]
                quoted = re.search(r"\"((?:\\.|[^\"\\])*)\"", after)
                if not quoted:
                    raise ValueError(f"{relative}: no help in {name}")
                help_text = json.loads('"' + quoted.group(1) + '"')
            elif literal:
                name = "hyperlane_" + json.loads('"' + literal.group(1) + '"')
                help_text = json.loads('"' + literal.group(2) + '"')
            else:
                raise ValueError(f"{relative}: unsupported descriptor macro")
            outer_args = split_args(body)
            if len(outer_args) < 2:
                raise ValueError(f"{relative}: malformed {identifier} arguments")
            labels = parse_labels(outer_args[1], arrays) if outer_args[1] in arrays else parse_labels(outer_args[1])
            buckets: list[float] = []
            if kind == "histogram":
                bucket_expression = re.search(r"vec!\s*\[[^\]]*\]", outer_args[0])
                if not bucket_expression:
                    raise ValueError(f"{relative}: no buckets in {name}")
                buckets = parse_buckets(bucket_expression.group(0))
            item = descriptor(name, help_text, kind, labels, buckets, relative)
            item["base_labels"] = "const_labels" in body
            output.append(item)

    # Relay API registers direct Prometheus constructors, unlike Core factories.
    if relative.endswith("relay_api/metrics.rs"):
        opts_calls = call_ranges(text, "Opts::new")
        counter_calls = call_ranges(text, "IntCounterVec::new")
        hist_calls = call_ranges(text, "HistogramOpts::new")
        if len(opts_calls) < 1 or len(counter_calls) < 1 or len(hist_calls) < 1:
            raise ValueError("unable to parse relay API direct descriptors")
        opts_args = split_args(opts_calls[0][2])
        counter_args = split_args(counter_calls[0][2])
        hist_args = split_args(hist_calls[0][2])
        if len(opts_args) < 2 or len(counter_args) < 2 or len(hist_args) < 2:
            raise ValueError("malformed relay API direct descriptors")
        labels = parse_labels(counter_args[1])
        output.append(descriptor(json.loads(opts_args[0]), json.loads(opts_args[1]), "int_counter", labels, [], relative))
        bucket_expression = re.search(r"\.buckets\(\s*vec!\s*\[([^\]]*)\]", text[hist_calls[0][1]:])
        if not bucket_expression:
            raise ValueError("no relay API histogram buckets")
        buckets = [float(x.strip().removesuffix(".0")) for x in split_args(bucket_expression.group(1)) if x.strip()]
        output.append(descriptor(json.loads(hist_args[0]), json.loads(hist_args[1]), "histogram", [], buckets, relative))

    for item in output:
        item["group"] = group
    return output


def unique(items: list[dict]) -> list[dict]:
    by_name = {item["name"]: item for item in sorted(items, key=lambda x: x["name"])}
    if len(by_name) != len(items):
        duplicates = [x["name"] for x in items if sum(y["name"] == x["name"] for y in items) > 1]
        raise ValueError(f"duplicate descriptors: {sorted(set(duplicates))}")
    return [by_name[name] for name in sorted(by_name)]


def render_items(items: list[dict]) -> str:
    lines = []
    for item in items:
        labels = ", ".join(f'"{x}"' for x in item["labels"])
        buckets = ", ".join(f"{x:.10g}" for x in item["buckets"])
        lines.append(
            '    .{{ .name = "{name}", .help = "{help}", .kind = .{kind}, .labels = &.{{ {labels} }}, .buckets = &.{{ {buckets} }}, .source = "{source}", .base_labels = {base_labels} }},'.format(
                name=item["name"],
                help=item["help"].replace('\\', '\\\\').replace('"', '\\"'),
                kind=item["kind"],
                labels=labels,
                buckets=buckets,
                source=item["source"],
                base_labels=str(item["base_labels"]).lower(),
            )
        )
    return re.sub(r'&\.\{ ("[^"\n]*") \}', r'&.{\1}', "\n".join(lines).replace("&.{  }", "&.{}"))


def chunks(text: str) -> list[str]:
    return [text[i:i + 32] for i in range(0, len(text), 32)]

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    package = tomllib.loads((ROOT / "rust/main/hyperlane-base/Cargo.toml").read_text())["package"]
    version = package["version"]
    if isinstance(version, dict) and version == {"workspace": True}:
        version = tomllib.loads((ROOT / "rust/main/Cargo.toml").read_text())["workspace"]["package"]["version"]
    if not isinstance(version, str):
        raise ValueError("unsupported hyperlane-base package version")
    groups = {
        "shared": unique([d for p in SHARED for d in parse_file(p, "shared")]),
        "lazy_shared": unique([d for p in LAZY for d in parse_file(p, "lazy_shared")]),
        "relayer": unique([d for p in RELAYER for d in parse_file(p, "relayer")]),
        "validator": unique([d for p in VALIDATOR for d in parse_file(p, "validator")]),
        "scraper": unique([d for p in SCRAPER for d in parse_file(p, "scraper")]),
    }
    manifest = {
        "sources": [
            {"path": p, "sha256": chunks(hashlib.sha256((ROOT / p).read_bytes()).hexdigest())}
            for p in ALL
        ],
        "counts": {name: len(items) for name, items in groups.items()},
        "baselib_version": version,
    }
    identity = hashlib.sha256(json.dumps(groups, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest["schema_sha256"] = chunks(identity)
    source_lines = [
        "//! GENERATED by zig/src/ops/tools/generate_metrics.py. DO NOT EDIT.",
        f"//! Source snapshot SHA-256 chunks: {identity[:32]} {identity[32:]}",
        'const std = @import("std");',
        "pub const Kind = enum { int_gauge, gauge, int_counter, counter, histogram };",
        "pub const Descriptor = struct {",
        "    name: []const u8,",
        "    help: []const u8,",
        "    kind: Kind,",
        "    labels: []const []const u8,",
        "    buckets: []const f64,",
        "    source: []const u8,",
        "    base_labels: bool,",
        "};",
        f'pub const schema_sha256 = "{identity[:32]}" ++ "{identity[32:]}";',
        f'pub const baselib_version = {json.dumps(version)};',
    ]
    for group_name in ("shared", "lazy_shared", "relayer", "validator", "scraper"):
        source_lines.append(f"pub const {group_name} = [_]Descriptor{{")
        source_lines.append(render_items(groups[group_name]))
        source_lines.append("};")
    source_lines.extend([
        "pub fn for_role(role: enum { relayer, validator, scraper }) []const Descriptor {",
        "    return switch (role) {",
        "        .relayer => &relayer,",
        "        .validator => &validator,",
        "        .scraper => &scraper,",
        "    };",
        "}",
        'test "generated descriptors have unique names and labels within each group" {',
        "    inline for (.{ shared, lazy_shared, relayer, validator, scraper }) |list| {",
        "        for (list, 0..) |item, i| {",
        '            try std.testing.expect(std.mem.startsWith(u8, item.name, "hyperlane_"));',
        "            for (list[0..i]) |other| try std.testing.expect(!std.mem.eql(u8, item.name, other.name));",
        "            for (item.labels, 0..) |label, j| for (item.labels[0..j]) |other| try std.testing.expect(!std.mem.eql(u8, label, other));",
        "        }",
        "    }",
        "}",
        "",
    ])
    source = "\n".join(source_lines)
    manifest_text = json.dumps(manifest, indent=2) + "\n"
    if args.check:
        if OUT.read_text() != source or MANIFEST.read_text() != manifest_text:
            raise SystemExit("metric schema/source manifest differs; regenerate from canonical Rust")
    else:
        OUT.write_text(source)
        MANIFEST.write_text(manifest_text)
    print(json.dumps({"identity": identity, "counts": manifest["counts"]}, indent=2))


if __name__ == "__main__":
    main()
