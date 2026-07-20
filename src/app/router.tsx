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
const WorldPage = lazy(() => import('../features/world/WorldPage').then((module) => ({
  default: module.WorldPage,
})));
const ArchivePage = lazy(() => import('../features/archive/ArchivePage').then((module) => ({
  default: module.ArchivePage,
})));
const ProfilePage = lazy(() => import('../features/archive/ProfilePage').then((module) => ({
  default: module.ProfilePage,
})));
const DocumentPage = lazy(() => import('../features/archive/DocumentPage').then((module) => ({
  default: module.DocumentPage,
})));
const GalleryPage = lazy(() => import('../features/archive/GalleryPage').then((module) => ({
  default: module.GalleryPage,
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
            <Route path="world" element={<WorldPage />} />
            <Route path="world/:documentId" element={<WorldPage />} />
            <Route path="archive" element={<ArchivePage />} />
            <Route path="archive/profiles/:id" element={<ProfilePage />} />
            <Route path="archive/documents/:id" element={<DocumentPage />} />
            <Route path="archive/gallery" element={<GalleryPage />} />
          </Route>
        </Routes>
      </Suspense>
    </HashRouter>
  );
}
