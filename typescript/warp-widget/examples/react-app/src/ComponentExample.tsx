import { useState } from 'react';
import { HyperlaneWarpWidget } from '@hyperlane-xyz/warp-widget/react';
import type { WarpWidgetConfig, WarpWidgetEvent } from '@hyperlane-xyz/warp-widget';

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

export function ComponentExample() {
  const [activeTheme, setActiveTheme] = useState('blue');
  const [events, setEvents] = useState<WarpWidgetEvent[]>([]);

  const config: WarpWidgetConfig = {
    ...themes[activeTheme],
    defaults: { origin: 'ethereum', destination: 'base' },
  };

  return (
    <div>
      <h2>React Component</h2>
      <p>
        <code>{'<HyperlaneWarpWidget />'}</code> from{' '}
        <code>@hyperlane-xyz/warp-widget/react</code>
        {events.length > 0 && (
          <span style={{ color: '#22c55e', marginLeft: 8 }}>
            {events.length} event{events.length > 1 ? 's' : ''}
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

      <div className="widget-frame">
        <HyperlaneWarpWidget
          key={activeTheme}
          config={config}
          onEvent={(e) => setEvents((prev) => [...prev, e])}
          width="440px"
          height="620px"
        />
      </div>
    </div>
  );
}
