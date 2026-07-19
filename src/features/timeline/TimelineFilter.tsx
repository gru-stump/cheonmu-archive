import type { JSX } from 'react';

export type TimelineStatus = 'all' | 'confirmed' | 'draft';

type TimelineFilterProps = {
  selected: TimelineStatus;
  onSelect: (status: TimelineStatus) => void;
};

const filters: ReadonlyArray<{ value: TimelineStatus; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'confirmed', label: '확정' },
  { value: 'draft', label: '초안' },
];

export function TimelineFilter({ selected, onSelect }: TimelineFilterProps): JSX.Element {
  return (
    <div className="timeline-filter" aria-label="기록 상태 필터">
      {filters.map((filter) => (
        <button
          key={filter.value}
          type="button"
          aria-pressed={selected === filter.value}
          onClick={() => onSelect(filter.value)}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}
