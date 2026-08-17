import { describe, expect, it } from 'vitest';
import {
  formatKrw,
  formatSeoulTimestamp,
  generationStatusCopy,
  krwToMicros,
  microsToKrw,
} from './narrativeDisplay';

describe('narrativeDisplay', () => {
  it('shows a Seoul timestamp with both a friendly relative label and an exact minute', () => {
    expect(formatSeoulTimestamp('2026-08-16T13:14:00Z', new Date('2026-08-16T13:20:00Z')))
      .toEqual({ relative: '오늘 오후 10:14', exact: '2026.08.16 22:14' });
    expect(formatSeoulTimestamp('2026-08-15T00:05:00Z', new Date('2026-08-16T13:20:00Z')))
      .toEqual({ relative: '어제 오전 9:05', exact: '2026.08.15 09:05' });
  });

  it('fails closed instead of printing an invalid date', () => {
    expect(formatSeoulTimestamp('not-a-date', new Date('2026-08-16T13:20:00Z')))
      .toEqual({ relative: '표시할 수 없는 시각', exact: '표시할 수 없는 시각' });
  });

  it('translates access worker failures without exposing the raw failure code', () => {
    expect(generationStatusCopy({
      source: 'access',
      state: 'failed/dead-letter',
      attemptCount: 3,
      failureCode: 'provider_outcome_unknown',
    })).toEqual({
      title: '접속 이야기 생성 중단',
      description: 'AI 요청 결과를 확인하지 못해 안전하게 중단했습니다.',
      action: 'API 키 문제로 단정할 수 없습니다. 잠시 뒤 다시 요청하고, 반복되면 운영 기록을 확인해 주세요.',
    });
  });

  it.each([
    ['provider_timeout', 'AI 응답이 너무 늦어 생성을 멈췄습니다.', '잠시 뒤 다시 요청해 주세요.'],
    ['provider_output_limit', '이야기를 완성하기 전에 AI의 글자 한도에 도달했습니다.', '권장 모델 설정을 적용한 뒤 다시 요청해 주세요.'],
    ['provider_connection_failed', 'AI 서비스와 연결이 도중에 끊겼습니다.', '잠시 뒤 다시 요청해 주세요.'],
  ])('explains %s in owner-friendly Korean', (failureCode, description, action) => {
    expect(generationStatusCopy({ source: 'access', state: 'failed/dead-letter', attemptCount: 1, failureCode }))
      .toEqual({ title: '접속 이야기 생성 중단', description, action });
  });

  it('uses safe generic copy for unknown internal states and codes', () => {
    expect(generationStatusCopy({
      source: 'unknown',
      state: 'unexpected-state',
      attemptCount: 0,
      failureCode: 'raw_database_detail',
    })).toEqual({
      title: '이야기 생성 상태 확인 필요',
      description: '생성 상태를 확인할 수 없습니다.',
      action: '새로고침한 뒤 계속되면 설정을 확인해 주세요.',
    });
  });

  it('converts internal micro-dollars to owner-friendly won without floating-point drift', () => {
    expect(microsToKrw(1_000_000, 1380)).toBe(1380);
    expect(krwToMicros(10_000, 1380)).toBe(7_246_377);
    expect(formatKrw(10_000)).toBe('10,000원');
  });
});
