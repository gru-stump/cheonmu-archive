import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import { loadAllContent } from '../../content/load';
import type { ArchiveDocument } from '../../content/schema';

type DocumentPageProps = {
  documents?: readonly ArchiveDocument[];
};

export function DocumentPage({ documents = loadAllContent().documents }: DocumentPageProps): JSX.Element {
  const { id } = useParams();
  const document = documents.find((item) => item.id === id);

  if (!document) {
    return (
      <section className="record-not-found" aria-labelledby="missing-document-title">
        <p className="document-kicker">Archive Error · 404</p>
        <h1 id="missing-document-title">문서를 찾을 수 없습니다</h1>
        <p>요청한 문서 식별자가 아카이브에 없습니다.</p>
        <Link className="primary-document-link" to="/archive">아카이브로 돌아가기</Link>
      </section>
    );
  }

  return (
    <article className="archive-detail">
      <Link className="back-link" to="/archive">← 아카이브</Link>
      <header className="archive-detail__header">
        <p className="document-kicker">Reference Document</p>
        <h1>{document.title}</h1>
      </header>
      <div className="markdown-document"><ReactMarkdown>{document.body}</ReactMarkdown></div>
    </article>
  );
}
