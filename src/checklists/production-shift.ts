import { localParts, wallTime } from './shifts.js';

export const PRODUCTION_TIMEZONE = 'Asia/Baku';

// Production draft intentionally has no weekday mapping. Admin must assign
// days before publish; only the four approved names and standard intervals
// are prefilled.
export function productionShiftDraft(effective_from: string) {
  return {
    timezone: PRODUCTION_TIMEZONE,
    effective_from,
    cycle_anchor: effective_from,
    rules: [
      { shift_key:'NOVBE_1', label:'Növbə 1', applicable_days:[], local_start_time:'20:00', local_end_time:'08:00', sort_order:0, active:true },
      { shift_key:'NOVBE_2', label:'Növbə 2', applicable_days:[], local_start_time:'08:00', local_end_time:'20:00', sort_order:1, active:true },
      { shift_key:'NOVBE_3', label:'Növbə 3', applicable_days:[], local_start_time:'20:00', local_end_time:'08:00', sort_order:2, active:true },
      { shift_key:'NOVBE_4', label:'Növbə 4', applicable_days:[], local_start_time:'08:00', local_end_time:'20:00', sort_order:3, active:true },
    ],
  };
}

export function currentProductionBoundary(now = new Date()): string {
  const local = localParts(now, PRODUCTION_TIMEZONE);
  const boundary = local.time < '08:00:00' ? '20:00' : local.time < '20:00:00' ? '08:00' : '20:00';
  const date = local.time < '08:00:00'
    ? new Date(Date.parse(local.date+'T00:00:00Z')-86400000).toISOString().slice(0,10)
    : local.date;
  return wallTime(date,boundary,PRODUCTION_TIMEZONE);
}
