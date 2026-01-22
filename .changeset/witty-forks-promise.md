---
'@hyperlane-xyz/cli': major
---

CLI array input handling changed from CSV parsing to native yargs array syntax. Commands now use `--chains a b c` or `--chains a --chains b` instead of `--chains a,b`. Affected options: `--chains`, `--validators`, `--destinations`. Fixed a bug in chain resolver where string spreading produced individual characters instead of chain names.
