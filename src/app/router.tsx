import type { JSX } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { HomePage } from '../features/home/HomePage';
import { RecordDetailPage } from '../features/timeline/RecordDetailPage';
import { TimelinePage } from '../features/timeline/TimelinePage';
import { AppShell } from './AppShell';

export function AppRouter(): JSX.Element {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="records" element={<TimelinePage />} />
          <Route path="records/:recordId" element={<RecordDetailPage />} />
          <Route path="archive" element={<div>{'\uC544\uCE74\uC774\uBE0C'}</div>} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
