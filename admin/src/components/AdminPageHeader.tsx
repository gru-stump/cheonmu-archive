import type { ReactNode } from 'react';

export function AdminPageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="admin-page-header">
    <div className="admin-page-header__copy">
      <p className="admin-page-header__eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="admin-page-header__description">{description}</p>
    </div>
    {action && <div className="admin-page-header__action">{action}</div>}
  </header>;
}
