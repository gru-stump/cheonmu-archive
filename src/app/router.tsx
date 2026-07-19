import type { JSX } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';

export function AppRouter(): JSX.Element {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<div>{'\uF9E3\uC495\u0422'}</div>} />
          <Route path="records" element={<div>{'\u6E72\uACD5\uC909\uF9E3?'}</div>} />
          <Route path="archive" element={<div>{'?\uAFA9\uBB45?\uB300\uD215'}</div>} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
