import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { loadAllContent } from '../../content/load';

export function HomePage(): JSX.Element {
  const content = loadAllContent();
  const relationship = content.documents.find((document) => document.id === 'relationship');
  const cheonryeongArt = content.gallery.find((item) => item.id === 'cheonryeong-ld');
  const muyeongArt = content.gallery.find((item) => item.id === 'muyeong-ld');

  return (
    <section className="home-page" aria-labelledby="home-title">
      <div className="home-copy">
        <p className="document-kicker">Special Disaster Agency · Pair File</p>
        <h1 id="home-title">천무</h1>
        <p className="home-hanja" aria-hidden="true">天無</p>
        <p className="home-lede">사람을 두고 나오지 못하는 지휘관과, 그런 지휘관을 죽게 두지 못하는 인외 의사.</p>
        <blockquote>“당신이 돌아올 곳에, 내가 있다.”</blockquote>
        <div className="home-actions">
          <Link className="primary-document-link" to="/records">기록 열람하기</Link>
          <span>{content.records.length.toString().padStart(2, '0')}개의 관계 기록</span>
        </div>
      </div>

      <div className="home-portraits" aria-label="천령과 무영">
        {cheonryeongArt && (
          <figure className="home-portrait home-portrait--cheonryeong">
            <img src={cheonryeongArt.image} alt={cheonryeongArt.alt} />
            <figcaption><b>천령</b><span>의사 · 연구원</span></figcaption>
          </figure>
        )}
        {muyeongArt && (
          <figure className="home-portrait home-portrait--muyeong">
            <img src={muyeongArt.image} alt={muyeongArt.alt} />
            <figcaption><b>무영</b><span>현장 지휘관</span></figcaption>
          </figure>
        )}
      </div>

      <footer className="home-file-note">
        <span>FILE CM–PAIR</span>
        <span>{relationship?.title ?? '천무 관계 프로필'}</span>
      </footer>
    </section>
  );
}
