import { useState } from 'react';
import { ComponentExample } from './ComponentExample';
import { ImperativeExample } from './ImperativeExample';

type Tab = 'component' | 'imperative';

export default function App() {
  const [tab, setTab] = useState<Tab>('component');

  return (
    <div style={{ minHeight: '100vh', background: '#f1f5f9', padding: '2rem' }}>
      <div style={{ maxWidth: 500, margin: '0 auto' }}>
        <h1>Warp Widget — React Examples</h1>
        <p>Two ways to use <code>@hyperlane-xyz/warp-widget</code> in React.</p>

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
          <button className={tab === 'component' ? 'active' : ''} onClick={() => setTab('component')}>
            Component
          </button>
          <button className={tab === 'imperative' ? 'active' : ''} onClick={() => setTab('imperative')}>
            Imperative
          </button>
        </div>

        {tab === 'component' ? <ComponentExample /> : <ImperativeExample />}
      </div>
    </div>
  );
}
