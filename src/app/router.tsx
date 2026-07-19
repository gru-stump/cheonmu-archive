import { lazy, Suspense, type JSX } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';

const HomePage = lazy(() => import('../features/home/HomePage').then((module) => ({
  default: module.HomePage,
})));
const TimelinePage = lazy(() => import('../features/timeline/TimelinePage').then((module) => ({
  default: module.TimelinePage,
})));
const RecordDetailPage = lazy(() => import('../features/timeline/RecordDetailPage').then((module) => ({
  default: module.RecordDetailPage,
})));

export function RouteLoadingFallback(): JSX.Element {
  return <p className="route-loading" role="status">기록을 불러오는 중입니다.</p>;
}

export function AppRouter(): JSX.Element {
  return (
    <HashRouter>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="records" element={<TimelinePage />} />
            <Route path="records/:recordId" element={<RecordDetailPage />} />
            <Route path="archive" element={<div>{'\uC544\uCE74\uC774\uBE0C'}</div>} />
          </Route>
        </Routes>
      </Suspense>
    </HashRouter>
  );
}
