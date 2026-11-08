# Helm deployment compatibility

The shared chart retains the Rust image defaults: relative `./relayer`,
`./validator`, `./scraper` commands; baked `/app/app-contexts/mainnet_config.json`;
image UID1000 and HOME; existing database paths. Changing only its image to Zig
cannot work: Zig binaries live in `/opt/hyperlane/bin`, WORKDIR is
`/var/lib/hyperlane`, and the base image deliberately contains no production
configuration. Neither image adds its role directory to PATH.

The opt-in `values-zig.yaml` uses absolute role commands, UID/GID10001, existing
fsGroup2000 and HOME `/var/lib/hyperlane`. It preserves the validator's existing
replica-specific config/secret environment wrapper. Choose the qualified image
explicitly; full-SDK workloads require the corresponding qualified full-SDK image.
The chart does not deploy automatically or infer an image from these values.

## Configuration delivery

A ConfigMap is an option only for an explicitly reviewed bounded configuration
set. Kubernetes limits a ConfigMap to1MiB total. The current canonical
`rust/main/app-contexts/mainnet_config.json` is1,764,121bytes, or1,176,555bytes even
when compacted; neither fits alone. Do not trim policy contexts or omit defaults
to make the canonical file fit. Credentials remain in the existing Secret/env
paths and must never be put in the image or ConfigMap.

For a legitimately bounded set, create a separately reviewed/versioned ConfigMap
containing the complete needed public JSON, and set
`hyperlane.defaultsConfigMap` to its exact name. All roles mount it read-only at
`/etc/hyperlane`. The relayer app-context path is explicit. A changed external
ConfigMap does not change the chart checksum: use a new name or an explicit
rollout; this chart cannot checksum external content.

For full canonical configuration, build a configured image from an already
qualified immutable Zig image. Copy only the complete reviewed nonsecret JSON,
without changing executable bytes, working directory, entrypoint or PATH:

```dockerfile
ARG QUALIFIED_ZIG_IMAGE
FROM ${QUALIFIED_ZIG_IMAGE}
USER 0:0
COPY --chown=0:0 defaults/ /etc/hyperlane/
RUN chmod 0555 /etc/hyperlane && chmod 0444 /etc/hyperlane/*.json
USER 10001:10001
```

The input must be a qualified `registry/image:tag@sha256:DIGEST` reference, not a
moving tag. Record its platform/manifest/config identity and every copied JSON
path/byte/hash as a separate image provenance closure. This is data-only image
configuration, not a new Rust/Zig runtime build. Keep key material outside this
context. Supply the derived image explicitly, then layer
`values-zig-configured.yaml` after `values-zig.yaml` so no ConfigMap masks its
baked `/etc/hyperlane` tree. For the chart's existing repository/tag interface,
`image.tag` may carry `chosen-tag@sha256:DIGEST`; the resulting complete image
reference remains digest-qualified.

The chart's role selectors are environment overrides, so they take precedence
above the public JSON. Set `hyperlane.relayer.envConfig.relayChains` and
`hyperlane.scraper.config.chainsToScrape` explicitly for the selected roles, and
align each validator's `hyperlane.validator.configs[].originChainName`. Empty
chart selector values override JSON too. The disposable CI fixture supplies
`containerfixture` explicitly.

## State ownership

Relayer/validator keep their existing `hyperlane.dbPath` PVC mount and HYP_DB.
Scraper uses its configured SQL database. No WORKDIR or `/var/lib/hyperlane`
symlink redirects an existing volume. The Zig profile selects UID10001/GID10001
and supplementary fsGroup2000. That declaration alone does not prove access to
an arbitrary existing PVC or that its CSI driver changes ownership.

The optional bootstrap's explicit ownerUid/ownerGid retain1000:2000 by default;
the Zig overlay selects10001:2000 for newly extracted state. No chmod or
permission fallback is added to bootstrap. Its existing skip branch leaves any
already-populated volume unchanged. A UID1000-owned0700 database remains
inaccessible to UID10001 until an explicit stopped snapshot/clone migration is
reviewed. Never change a live PVC's ownership as part of an image switch.

## CI lifecycle qualification

The ordinary container job checks the core image. The matching ReleaseSafe and
ReleaseFast SDK jobs each check their full-SDK image, using the same migration
image and disposable PG16.15/21-migration/RPC fixture. Each Helm slice renders
every role using Helm3.15.2, runs the exact command/environment override with bounded
read-only ConfigMap fixtures and data-only configured-image fixtures, and
performs two actual startup/SIGTERM/same-state runs per role per delivery mode.
All three image flavors must pass: twelve lifecycle runs each, thirty-six total.
The checks record actual nonroot identities, PID1 executable (including the rendered
validator shell where present), read-only defaults and exact owned CID
stop/wait/removal/negative-inspect results. These are Docker daemon/container
wait observations, not invented host-parent waits for container processes.

Ownership fixtures use a new disposable directory: UID1000-owned0700 access must
fail; after explicit fixture-only ownership to10001:2000 it must succeed. No
production state, Kubernetes cluster, PVC, production signer or production
checkpoint publication is used. Successful Docker fixture evidence does not assert real CSI/fsGroup
behavior, final18native acceptance or performance. An actual passing published
`helm-runtime.json` at the exact source/image head is required; render/pure tests
alone do not constitute this lifecycle acceptance.

### Validator process handoff

The Zig values overlay sets `hyperlane.validator.execProcess: true`. The existing
RID extraction and config/secret environment loading remain, followed by `exec
env ... /opt/hyperlane/bin/validator`, so the validator can receive container
SIGTERM directly. The option must be boolean; default Rust values retain `false`
and their existing rendered wrapper. Do not compensate with a longer grace or
accept exit137. The observed pre-fix disposable SDK validator had dash as PID1
and exited137 without OOM; all owned containers and PG were removed.

The new wrapper still requires actual core, Safe and Fast lifecycle readbacks
(three roles, two configuration modes, two same-data runs per profile:36 total).
Those post-fix results remain pending; renders and unit controls are not a
Kubernetes rollout, existing-PVC migration, native600/30 or performance proof.
