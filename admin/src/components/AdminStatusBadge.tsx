import type { ReactNode } from 'react';

export type AdminStatusTone = 'neutral' | 'green' | 'plum' | 'danger' | 'warning';

export function AdminStatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: AdminStatusTone }) {
  const text = typeof children === 'string' ? children : undefined;
  return <span className={`admin-status-badge admin-status-badge--${tone}`} aria-label={text ? `상태: ${text}` : '상태'}>{children}</span>;
}
