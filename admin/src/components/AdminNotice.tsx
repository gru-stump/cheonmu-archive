import type { ReactNode } from 'react';

export type AdminNoticeTone = 'info' | 'success' | 'warning' | 'danger' | 'readonly';

export function AdminNotice({ children, tone = 'info', action, live = true }: { children: ReactNode; tone?: AdminNoticeTone; action?: ReactNode; live?: boolean }) {
  const urgent = tone === 'danger';
  return <div className={`admin-notice admin-notice--${tone}`} {...(live ? { role: urgent ? 'alert' : 'status', 'aria-live': urgent ? 'assertive' as const : 'polite' as const } : {})}>
    <div className="admin-notice__body">{children}</div>
    {action && <div className="admin-notice__action">{action}</div>}
  </div>;
}
