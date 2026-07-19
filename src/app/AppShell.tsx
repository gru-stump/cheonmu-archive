import type { JSX } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

export function AppShell(): JSX.Element {
  return (
    <div>
      <header>
        <nav aria-label="Archive navigation">
          <NavLink to="/">{'\uF9E3\uC495\u0422'}</NavLink>
          <NavLink to="/records">{'\u6E72\uACD5\uC909\uF9E3?'}</NavLink>
          <NavLink to="/archive">{'?\uAFA9\uBB45?\uB300\uD215'}</NavLink>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
