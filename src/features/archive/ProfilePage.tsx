import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import { loadAllContent } from '../../content/load';
import type { ArchiveProfile } from '../../content/schema';

type ProfilePageProps = {
  profiles?: readonly ArchiveProfile[];
};

export function ProfilePage({ profiles = loadAllContent().profiles }: ProfilePageProps): JSX.Element {
  const { id } = useParams();
  const profile = profiles.find((item) => item.id === id);

  if (!profile) {
    return (
      <section className="record-not-found" aria-labelledby="missing-profile-title">
        <p className="document-kicker">Archive Error · 404</p>
        <h1 id="missing-profile-title">인물 자료를 찾을 수 없습니다</h1>
        <p>요청한 인물 식별자가 아카이브에 없습니다.</p>
        <Link className="primary-document-link" to="/archive">아카이브로 돌아가기</Link>
      </section>
    );
  }

  return (
    <article className="archive-detail">
      <Link className="back-link" to="/archive">← 아카이브</Link>
      <header className="archive-detail__header">
        <p className="document-kicker">Character Profile</p>
        <h1>{profile.title}</h1>
        {profile.height && <p>신장 {profile.height}</p>}
      </header>
      <div className="markdown-document"><ReactMarkdown>{profile.body}</ReactMarkdown></div>
    </article>
  );
}
