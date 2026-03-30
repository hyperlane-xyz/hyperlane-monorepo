import { useEffect, useRef, useState } from 'react';
import { createWarpWidget } from '@hyperlane-xyz/warp-widget';
import type { WarpWidgetConfig } from '@hyperlane-xyz/warp-widget';

const themes: Record<string, WarpWidgetConfig> = {
  blue: {
    theme: {
      accent: '3b82f6',
      bg: 'f8fafc',
      card: 'ffffff',
      text: '0f172a',
      border: 'e2e8f0',
    },
  },
  dark: {
    theme: {
      mode: 'dark',
      accent: '8b5cf6',
      bg: '0f172a',
      card: '1e293b',
      text: 'e2e8f0',
      border: '334155',
    },
  },
  green: {
    theme: {
      accent: '22c55e',
      bg: 'f0fdf4',
      card: 'ffffff',
      text: '14532d',
      border: 'bbf7d0',
    },
  },
};

export function ImperativeExample() {
  const [activeTheme, setActiveTheme] = useState('blue');
  const [readyCount, setReadyCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const widget = createWarpWidget({
      container,
      config: {
        ...themes[activeTheme],
        defaults: { origin: 'ethereum', destination: 'base' },
      },
      width: '440px',
      height: '620px',
    });

    const unsub = widget.on('ready', () => setReadyCount((c) => c + 1));

    return () => {
      unsub();
      widget.destroy();
    };
  }, [activeTheme]);

  return (
    <div>
      <h2>Imperative API</h2>
      <p>
        <code>createWarpWidget()</code> from{' '}
        <code>@hyperlane-xyz/warp-widget</code>
        {readyCount > 0 && (
          <span style={{ color: '#22c55e', marginLeft: 8 }}>
            Ready ({readyCount})
          </span>
        )}
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        {Object.keys(themes).map((name) => (
          <button
            key={name}
            onClick={() => setActiveTheme(name)}
            className={activeTheme === name ? 'active' : ''}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="widget-frame" ref={containerRef} />
    </div>
  );
}
