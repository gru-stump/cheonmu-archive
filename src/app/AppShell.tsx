import type { JSX } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

export function AppShell(): JSX.Element {
  return (
    <div className="archive-shell">
      <header className="archive-rail">
        <nav className="archive-navigation" aria-label="Archive navigation">
          <NavLink to="/">{'\uCC9C\uBB34'}</NavLink>
          <NavLink to="/records">{'\uAE30\uB85D\uCCA0'}</NavLink>
          <NavLink to="/world">세계관</NavLink>
          <NavLink to="/archive">{'\uC544\uCE74\uC774\uBE0C'}</NavLink>
        </nav>
      </header>
      <main className="document-workspace">
        <Outlet />
      </main>
    </div>
  );
}
