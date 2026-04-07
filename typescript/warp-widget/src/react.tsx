import React, { type CSSProperties, useEffect, useMemo, useRef } from 'react';
import { createWarpWidget } from './index.js';
import type {
  WarpWidgetConfig,
  WarpWidgetEvent,
  WarpWidgetInstance,
} from './types.js';

export type {
  WarpWidgetConfig,
  WarpWidgetDefaults,
  WarpWidgetEvent,
  WarpWidgetTheme,
} from './types.js';

interface HyperlaneWarpWidgetProps {
  /** Widget configuration (theme, defaults, routes) */
  config?: WarpWidgetConfig;
  /** Called when the widget emits an event */
  onEvent?: (event: WarpWidgetEvent) => void;
  /** Iframe width (default: '100%') */
  width?: string;
  /** Iframe height (default: '600px') */
  height?: string;
  /** CSS class name for the container div */
  className?: string;
  /** Inline styles for the container div */
  style?: CSSProperties;
}

/** Stable JSON serialization with sorted keys to avoid spurious iframe re-mounts. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/**
 * React component that renders the Hyperlane Warp bridge widget.
 *
 * @example
 * ```tsx
 * <HyperlaneWarpWidget
 *   config={{
 *     theme: { accent: '3b82f6', mode: 'dark' },
 *     routes: ['USDC/arbitrum-ethereum'],
 *   }}
 *   onEvent={(e) => console.log(e)}
 * />
 * ```
 */
export function HyperlaneWarpWidget({
  config,
  onEvent,
  width,
  height,
  className,
  style,
}: HyperlaneWarpWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<WarpWidgetInstance | null>(null);
  const configRef = useRef(config);
  const onEventRef = useRef(onEvent);
  const widthRef = useRef(width);
  const heightRef = useRef(height);
  configRef.current = config;
  onEventRef.current = onEvent;
  widthRef.current = width;
  heightRef.current = height;

  // Memoize config key for stable dependency — avoids iframe recreation on identical configs
  const configKey = useMemo(() => stableStringify(config ?? {}), [config]);

  // Create/recreate iframe when config changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const widget = createWarpWidget({
      container,
      config: configRef.current,
      width: widthRef.current,
      height: heightRef.current,
    });
    widgetRef.current = widget;

    // Subscribe to known event types.
    // When new events are added to the embed protocol, add subscriptions here.
    const unsubReady = widget.on('ready', (payload) => {
      onEventRef.current?.({ type: 'ready', payload });
    });

    return () => {
      unsubReady();
      widget.destroy();
      widgetRef.current = null;
    };
  }, [configKey]);

  // Resize iframe in-place without reload
  useEffect(() => {
    const iframe = widgetRef.current?.iframe;
    if (!iframe) return;
    iframe.style.width = width ?? '100%';
    iframe.style.height = height ?? '600px';
  }, [width, height]);

  return <div ref={containerRef} className={className} style={style} />;
}
