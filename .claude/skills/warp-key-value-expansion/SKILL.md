---
name: warp-key-value-expansion
description: Canonical legend for expanding a `<KEY_<PROTOCOL>_VALUE>` placeholder into a shell substitution based on the key-context artifact's `source` field, plus the mandatory `pnpm --silent` rule that keeps the resolved key out of logs and the display-the-key-name-before-CONFIRM disclosure. Referenced by every warp deploy/update skill that passes a `--key.<protocol>` flag.
---

# Warp Key-Value Expansion

`/warp-deploy-select-keys` writes a per-ticket key-context artifact (`~/.hyperlane/key-contexts/<ticket-id>.yaml`) with, per protocol, a `keys.<protocol>.name`, `keys.<protocol>.source`, and derived `keys.<protocol>.address`. Every downstream skill that runs a signing CLI command references a key as a `<KEY_<PROTOCOL>_VALUE>` placeholder and must expand it the same way — this skill is the single source of that mapping so the copies can't drift.

## Expansion legend

Substitute `<KEY_<PROTOCOL>_VALUE>` (e.g. `<KEY_ETHEREUM_VALUE>`, `<KEY_SEALEVEL_VALUE>`) per the artifact's `source` field for that protocol:

| `source` field | Expansion of `<KEY_VALUE>`                                                                                                                                                                      | Notes                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `gcp-secret`   | `"$(gcloud secrets versions access latest --secret=<name>)"`                                                                                                                                    | The raw private key is consumed inline by the CLI process and never lives in conversation logs or shell history. |
| `env-var`      | `"$<name>"`                                                                                                                                                                                     | The env var must be exported in the shell session before running the command.                                    |
| `keystore`     | `"$(cat <path>)"` for a plaintext-key file. For an **encrypted** keystore, halt with a clear error and ask the user to supply an env-var / gcp-secret form or the derived private key directly. | Encrypted-keystore unlocking is not yet plumbed through the warp-deploy chain (Phase 2 wiring).                  |

## `pnpm --silent` is mandatory for any `--key.<protocol>` command

**Always invoke the CLI via `pnpm --silent …` for any command that takes a `--key.<protocol>` flag.** Without `--silent`, pnpm prints an execution banner of the form `$ node ./dist/cli.js <cmd> … --key.ethereum 0x<rawkey>` _after_ shell substitution — that banner echoes the resolved argv (including the raw key) into stdout, defeating the `gcloud secrets versions access` / `cat` substitution that is supposed to keep the raw key out of logs. `--silent` suppresses the banner entirely. This is non-negotiable for sign commands; the leak applies to every `--key.<protocol>` flag in the warp-deploy/update chain.

## Disclose the key at every `[CONFIRM:]` gate

Before any `[CONFIRM:]` gate that precedes a signing command, display the resolved secret NAME (or env-var name) and the corresponding derived `address` from the artifact. The human approving the gate must see both — which key was picked, and which signer that key produces. That disclosure is the safeguard against wrong-key foot-guns; never show the raw key value itself.

## Consumers

`/warp-deploy-select-keys` (its own address-derivation commands), `/warp-deploy-validate-owners`, `/warp-deploy-init-route`, `/warp-deploy-update-owners`, `/warp-update`, `/warp-update-extend` — every skill that expands a `--key.<protocol>` flag.
