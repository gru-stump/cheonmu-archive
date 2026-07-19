import type { JSX } from 'react';

type StatusStampProps = {
  status: 'confirmed' | 'draft';
};

const statusLabels: Record<StatusStampProps['status'], string> = {
  confirmed: '확정 기록',
  draft: '초안 기록',
};

export function StatusStamp({ status }: StatusStampProps): JSX.Element {
  return (
    <span className="status-stamp" data-status={status}>
      {statusLabels[status]}
    </span>
  );
}
