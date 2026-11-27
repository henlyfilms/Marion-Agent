// Pure layout and label helpers for the Statistics dialog (StatsDashboard), kept apart so they can be unit tested.
import type { StatsDay, StatsSummary } from '@shared/types';

/** Server days are calendar dates (YYYY-MM-DD); they are read and formatted as UTC so no time zone shifts them. */
export const parseDay = (date: string) => new Date(`${date}T00:00:00Z`);

export interface HeatmapLayout {
  /** Seven cells per column (Sunday first); `null` pads the first week up to the first day. */
  cells: (StatsDay | null)[];
  weeks: number;
  /** Month labels above the columns where a month starts, at least three columns apart so they never overlap. */
  months: { column: number; label: string }[];
}

const MIN_LABEL_GAP = 3;

export function heatmapLayout(days: readonly StatsDay[], locale?: string): HeatmapLayout {
  if (!days.length) return { cells: [], weeks: 0, months: [] };
  const month = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const lead = parseDay(days[0].date).getUTCDay();
  const cells: (StatsDay | null)[] = [...Array<null>(lead).fill(null), ...days];
  const weeks = Math.ceil(cells.length / 7);
  const years = new Set(days.map(day => day.date.slice(0, 4))).size > 1;
  const label = (date: string, first: boolean) => {
    const at = parseDay(date);
    // Across several years, January (and the very first label) also says which year.
    return years && (first || at.getUTCMonth() === 0) ? `${month.format(at)} ${at.getUTCFullYear()}` : month.format(at);
  };
  const starts: { column: number; date: string }[] = [];
  for (let column = 0; column < weeks; column++) {
    const week = cells.slice(column * 7, column * 7 + 7);
    const first = week.find(day => day && day.date.endsWith('-01'));
    if (first) starts.push({ column, date: first.date });
  }
  // The first column names its own month unless a new month starts right after it.
  if (!starts.length || starts[0].column >= MIN_LABEL_GAP) starts.unshift({ column: 0, date: days[0].date });
  const months: HeatmapLayout['months'] = [];
  for (const start of starts) {
    if (months.length && start.column - months[months.length - 1].column < MIN_LABEL_GAP) continue;
    months.push({ column: start.column, label: label(start.date, months.length === 0) });
  }
  return { cells, weeks, months };
}

/** The toolbar's date line: "Nov 20 – Nov 26", with years when they differ, and "Since Mar 3, 2025" for All time. */
export function rangeLabel(data: Pick<StatsSummary, 'range' | 'from' | 'to' | 'since'>, locale?: string) {
  const full = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const short = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (data.range === 'all') return data.since ? `Since ${full.format(parseDay(data.since))}` : 'No activity yet';
  const format = data.from.slice(0, 4) === data.to.slice(0, 4) ? short : full;
  return `${format.format(parseDay(data.from))} – ${format.format(parseDay(data.to))}`;
}
