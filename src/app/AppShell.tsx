import type { JSX } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

export function AppShell(): JSX.Element {
  return (
    <div>
      <header>
        <nav aria-label="Archive navigation">
          <NavLink to="/">{'\uCC9C\uBB34'}</NavLink>
          <NavLink to="/records">{'\uAE30\uB85D\uCCA0'}</NavLink>
          <NavLink to="/archive">{'\uC544\uCE74\uC774\uBE0C'}</NavLink>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
