# @hyperlane-xyz/warp-widget

## 2.0.1

### Patch Changes

- c520224: Invariant regular expressions were reused across calls, redundant URL parsing was removed from RPC-header and explorer helpers, and independent token reads were overlapped with bounded concurrency and failure draining. URL normalization, validation, and dependent read ordering were preserved.

## 2.0.0

### Major Changes

- d21275b: Added @hyperlane-xyz/warp-widget — iframe-based SDK for embedding the Hyperlane Warp bridge in any web app

## 1.0.0

### Major Changes

- 981dfd7: Added @hyperlane-xyz/warp-widget — iframe-based SDK for embedding the Hyperlane Warp bridge in any web app
