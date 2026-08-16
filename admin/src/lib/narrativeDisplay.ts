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
  access: '접속 이야기',
  manual: '직접 요청한 이야기',
  schedule: '예약 이야기',
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
  if (input.state === 'failed/dead-letter' && input.failureCode === 'provider_outcome_unknown') {
    return {
      title: `${source} 생성 중단`,
      description: 'AI 요청 결과를 확인하지 못해 안전하게 중단했습니다.',
      action: '설정과 API 키를 확인해 주세요.',
    };
  }
  if (input.state === 'failed/dead-letter') {
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
