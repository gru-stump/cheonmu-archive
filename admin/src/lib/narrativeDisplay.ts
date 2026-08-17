const SEOUL_TIME_ZONE = 'Asia/Seoul';
const INVALID_TIME = '표시할 수 없는 시각';

type GenerationStatusInput = {
  source: 'manual' | 'schedule' | 'access' | 'unknown' | string;
  state: 'queued' | 'running' | 'retry-wait' | 'completed' | 'failed/dead-letter' | string;
  attemptCount: number;
  failureCode: string | null;
};

export type GenerationStatusCopy = {
  title: string;
  description: string;
  action: string | null;
};

function dateParts(value: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SEOUL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function dayKey(value: Date) {
  const { year, month, day } = dateParts(value);
  return `${year}-${month}-${day}`;
}

export function formatSeoulTimestamp(iso: string, now = new Date()) {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime()) || Number.isNaN(now.getTime())) {
    return { relative: INVALID_TIME, exact: INVALID_TIME };
  }

  const { year, month, day, hour, minute } = dateParts(value);
  const hourNumber = Number(hour);
  const period = hourNumber < 12 ? '오전' : '오후';
  const twelveHour = hourNumber % 12 || 12;
  const exact = `${year}.${month}.${day} ${hour}:${minute}`;
  const relativeDate = dayKey(value) === dayKey(now)
    ? '오늘'
    : dayKey(value) === dayKey(new Date(now.getTime() - 86_400_000))
      ? '어제'
      : `${month}월 ${day}일`;
  return { relative: `${relativeDate} ${period} ${twelveHour}:${minute}`, exact };
}

const sourceLabels: Record<string, string> = {
  access: '이야기',
  manual: '직접 요청한 이야기',
  schedule: '예약 이야기',
};

export const draftStatusLabels: Record<string, string> = {
  queued: '대기 중',
  generating: '만드는 중',
  generated: '새 초안',
  reviewing: '검토 진행 중',
  rejected: '거절됨',
  archived: '보관됨',
  approved_private: '비공개 승인',
  approved: '게시 승인',
  publishing: '게시 중',
  published: '공개 완료',
  publish_failed: '게시 실패',
};

export type DraftBadgeTone = 'neutral' | 'green' | 'plum' | 'danger' | 'warning';

export function draftStatusTone(status: string): DraftBadgeTone {
  if (status === 'rejected' || status === 'publish_failed') return 'danger';
  if (status === 'generated' || status === 'reviewing') return 'warning';
  if (status === 'approved' || status === 'published') return 'green';
  if (status === 'approved_private') return 'plum';
  return 'neutral';
}

export const draftStatusGuides: Record<string, string> = {
  queued: '잠시 후 AI가 이야기를 만들기 시작합니다.',
  generating: 'AI가 이야기를 만들고 있습니다. 잠시 후 다시 확인해 주세요.',
  generated: '본문을 읽고 아래에서 승인, 수정, 거절 중 하나를 선택해 주세요.',
  reviewing: '수정본이 저장된 검토 상태입니다. 이어서 승인하거나 거절할 수 있습니다.',
  rejected: '거절 사유가 다음 생성에 반영됩니다. 다시 살펴보려면 아래 버튼으로 검토를 열 수 있습니다.',
  archived: '보관된 초안입니다. 복원하면 보관 전 상태로 돌아갑니다.',
  approved_private: '사이트에는 올라가지 않고, 이야기 기억에만 반영됩니다.',
  approved: '게시가 승인되어 곧 공개 절차가 시작됩니다.',
  publishing: '공개 사이트에 올리는 중입니다. 잠시 후 자동으로 공개 완료로 바뀝니다.',
  published: '공개 사이트에 게시된 이야기입니다.',
  publish_failed: '게시가 실패했습니다. 아래 작업 메뉴에서 게시 재시도를 눌러 주세요.',
};

export const failureReasonCopy: Record<string, { description: string; action: string | null }> = {
  provider_timeout: { description: 'AI 응답이 너무 늦어 생성을 멈췄습니다.', action: '잠시 뒤 다시 요청해 주세요.' },
  provider_output_limit: { description: '이야기를 완성하기 전에 AI의 글자 한도에 도달했습니다.', action: '권장 모델 설정을 적용한 뒤 다시 요청해 주세요.' },
  provider_connection_failed: { description: 'AI 서비스와 연결이 도중에 끊겼습니다.', action: '잠시 뒤 다시 요청해 주세요.' },
  provider_outcome_unknown: {
    description: 'AI 요청 결과를 확인하지 못해 안전하게 중단했습니다.',
    action: 'API 키 문제로 단정할 수 없습니다. 잠시 뒤 다시 요청하고, 반복되면 운영 기록을 확인해 주세요.',
  },
};

export function generationStatusCopy(input: GenerationStatusInput): GenerationStatusCopy {
  const source = sourceLabels[input.source];
  if (!source) {
    return {
      title: '이야기 생성 상태 확인 필요',
      description: '생성 상태를 확인할 수 없습니다.',
      action: '새로고침한 뒤 계속되면 설정을 확인해 주세요.',
    };
  }

  if (input.state === 'queued') return { title: `${source} 생성 대기 중`, description: '잠시 후 AI가 이야기를 만들기 시작합니다.', action: null };
  if (input.state === 'running') return { title: `${source} 생성 중`, description: 'AI가 이야기를 만들고 있습니다.', action: null };
  if (input.state === 'retry-wait') return { title: `${source} 다시 시도 대기 중`, description: '일시적인 문제로 잠시 뒤 자동으로 다시 시도합니다.', action: null };
  if (input.state === 'completed') return { title: `${source} 생성 완료`, description: '새 초안을 검토할 수 있습니다.', action: null };
  if (input.state === 'failed/dead-letter') {
    const reason = input.failureCode ? failureReasonCopy[input.failureCode] : undefined;
    if (reason) return { title: `${source} 생성 중단`, description: reason.description, action: reason.action };
    return { title: `${source} 생성 중단`, description: '여러 번 시도했지만 완료하지 못했습니다.', action: '설정을 확인한 뒤 다시 요청해 주세요.' };
  }
  return {
    title: '이야기 생성 상태 확인 필요',
    description: '생성 상태를 확인할 수 없습니다.',
    action: '새로고침한 뒤 계속되면 설정을 확인해 주세요.',
  };
}

export function microsToKrw(micros: number, krwPerUsd: number) {
  if (!Number.isFinite(micros) || !Number.isFinite(krwPerUsd) || micros < 0 || krwPerUsd <= 0) return 0;
  return Math.round((micros / 1_000_000) * krwPerUsd);
}

export function krwToMicros(krw: number, krwPerUsd: number) {
  if (!Number.isFinite(krw) || !Number.isFinite(krwPerUsd) || krw < 0 || krwPerUsd <= 0) return 0;
  return Math.round((krw / krwPerUsd) * 1_000_000);
}

export function formatKrw(value: number) {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return `${new Intl.NumberFormat('ko-KR').format(safeValue)}원`;
}
