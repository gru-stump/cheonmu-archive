import { describe, expect, it } from 'vitest';
import { loadAllContent, validateContent } from './load';

const NEW_IMAGE_PATHS = [
  '/images/Cheonryeong_LD.png',
  '/images/Cheonryeong_head.png',
  '/images/Muyeong_LD.png',
  '/images/Muyeong_head.png',
];

const OLD_IMAGE_PATHS = [
  '/images/cheonmu-full.png',
  '/images/cheonmu-pair-template.png',
  '/images/creator-profile.png',
];

const FORBIDDEN_PUBLIC_SECRETS = [
  '천령은 인간',
  '인간 의사',
  '피를 마시는 흡혈귀',
  '백사',
  '실제 나이 불명',
  '과거와 능력으로',
];

describe('initial Cheonmu archive content', () => {
  // CM-07·08은 공개 전까지 records/_hidden/에 보관한다. 복원 시 8단계 기대값으로 되돌릴 것.
  it('contains six confirmed stages with cinematics exactly at 1, 3, and 5', () => {
    const content = loadAllContent();

    expect(content.records.map((record) => record.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(content.records.filter((record) => record.cinematic).map((record) => record.stage))
      .toEqual([1, 3, 5]);
    expect(content.records.map((record) => record.status)).toEqual(Array(6).fill('confirmed'));
  });

  it('keeps the public first-contact summary separate from the cinematic prose', () => {
    const record = loadAllContent().records.find((item) => item.id === 'first-contact');

    expect(record?.body).toContain('현장 임시 치료소');
    expect(record?.body).not.toContain('그럼에도 이번만큼은, 그 판단을 의심할 힘이 남아 있지 않았다.');
    expect(record?.cinematicBody).toContain('## 격리선 밖의 의사');
    expect(record?.cinematicBody).toContain('그럼에도 이번만큼은, 그 판단을 의심할 힘이 남아 있지 않았다.');
  });

  it('uses the canonical character heights without claiming Muyeong is taller', () => {
    const content = loadAllContent();
    const cheonryeong = content.profiles.find((profile) => profile.id === 'cheonryeong');
    const muyeong = content.profiles.find((profile) => profile.id === 'muyeong');

    expect(cheonryeong?.height).toBe('186cm');
    expect(muyeong?.height).toBe('185cm');
    expect(muyeong?.body).not.toContain('천령보다 키와 골격이 크고');
    expect(validateContent(content).errors).not.toContain('무영 신장이 185cm와 189cm로 충돌합니다.');
  });

  it('publishes only the four new transparent character images with credit', () => {
    const gallery = loadAllContent().gallery;

    expect(gallery.map((item) => item.image)).toEqual(NEW_IMAGE_PATHS);
    expect(gallery.map((item) => item.image)).not.toEqual(expect.arrayContaining(OLD_IMAGE_PATHS));
    expect(gallery.every((item) => item.creator === '불가사리')).toBe(true);
    expect(gallery.every((item) => !('source' in item))).toBe(true);
  });

  it('removes the three retired public assets', () => {
    const publicImagePaths = Object.keys(import.meta.glob('/public/images/**/*'))
      .map((path) => path.replace(/^\/public/, ''));

    expect(publicImagePaths).toEqual(expect.arrayContaining(NEW_IMAGE_PATHS));
    expect(publicImagePaths).not.toEqual(expect.arrayContaining(OLD_IMAGE_PATHS));
  });

  it('includes every sourced appellation and its relationship change note', () => {
    const relationship = loadAllContent().documents.find((document) => document.id === 'relationship');
    const relationshipBody = relationship?.body.replace(/\r\n/g, '\n');

    expect(relationshipBody).toContain('## 호칭');
    expect(relationshipBody).toContain('### 천령 → 무영');
    expect(relationshipBody).toContain('지휘관 씨\n- 지휘관님 / 우리 지휘관님 — 일부러 예의를 과장해 비꼬거나 장난칠 때만 사용\n- 환자분\n- 고질적인 환자');
    expect(relationshipBody).toContain('### 무영 → 천령');
    expect(relationshipBody).toContain('천령\n- 천령 선생\n- 선생님\n- 의료관님');
    expect(relationshipBody).toContain('## 관계가 깊어진 뒤의 변화');
    expect(relationshipBody).toContain('심각한 상황이나 감정이 흔들릴 때는 ‘무영’이라고만 부른다');
    expect(relationshipBody).toContain('감정이 흔들릴 때는 ‘천령’이라고만 부른다');
  });
});

describe('public archive secrecy', () => {
  it('keeps direct identity and ability disclosures out of public content', () => {
    const content = loadAllContent();
    const publicText = JSON.stringify({
      profiles: content.profiles,
      documents: content.documents,
      records: content.records,
    });

    expect(content.documents.map((item) => item.id)).not.toContain('settings');
    for (const secret of FORBIDDEN_PUBLIC_SECRETS) {
      expect(publicText).not.toContain(secret);
    }
  });

  it('keeps the CM-06 relationship stage without naming the hidden identity', () => {
    const stageSix = loadAllContent().records.find((record) => record.stage === 6);

    expect(stageSix?.id).toBe('keeping-distance');
    expect(stageSix?.body).toContain('통제 밖으로 벗어나는 것을 견디지 못하는 치료사');
    expect(stageSix?.body).not.toContain('인간');
    expect(stageSix?.quote).toBe('네가 가버린다고 판단했어');
  });

  it('describes CM-05 treatment without confirming a hidden ability', () => {
    const stageFive = loadAllContent().records.find((record) => record.stage === 5);
    expect(stageFive?.body).toContain('천령의 치료로도 돌이키기 어려운 증상');
    expect(stageFive?.body).not.toContain('천령의 능력');
  });
});
