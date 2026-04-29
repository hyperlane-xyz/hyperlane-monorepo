/**
 * Ambient declarations for `@hyperlane-xyz/core` per-EVM-target subpath
 * exports. Each subpath ships typechain factories with class names
 * identical to the default cancun bundle, but compiled for the named
 * EVM target. Resolved dynamically by `MultiProvider.resolveEvmTargetFactory`.
 *
 * Typed as Record<string, any> because the resolver looks up factory
 * classes by `factory.constructor.name` at runtime, not statically.
 */
declare module '@hyperlane-xyz/core/paris' {
  const exports: Record<string, any>;
  export = exports;
}
