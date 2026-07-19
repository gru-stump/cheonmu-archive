import type { JSX } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';

export function AppRouter(): JSX.Element {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<div>{'\uCC9C\uBB34'}</div>} />
          <Route path="records" element={<div>{'\uAE30\uB85D\uCCA0'}</div>} />
          <Route path="archive" element={<div>{'\uC544\uCE74\uC774\uBE0C'}</div>} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
