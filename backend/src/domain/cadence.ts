/**
 * Cadence -> due-date arithmetic (progress.md Section A.3's Cadence union).
 * Pure date math, no I/O — the scheduler (scheduler/generateDueCycles.ts)
 * is what actually reads/writes obligations and cycles.
 *
 * All arithmetic is done in UTC explicitly (Date.UTC / getUTC*), never
 * local time — every other timestamp in this codebase is an ISO/UTC
 * string, and cadence math running in the server process's local timezone
 * would silently shift due dates depending on where it's deployed.
 */

import type { Cadence } from "./types.js";

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function nextWeekdayAtOrAfter(from: Date, dayOfWeek: number): Date {
  const start = startOfUtcDay(from);
  const diff = (dayOfWeek - start.getUTCDay() + 7) % 7;
  return addDays(start, diff);
}

/** Clamps to the last real day of the month when dayOfMonth exceeds it
 *  (e.g. dayOfMonth=31 in February -> Feb 28/29). Always computed from the
 *  ORIGINAL configured dayOfMonth, never from a previously-clamped value —
 *  otherwise a clamp in a short month would permanently shrink every
 *  following month too (Feb 28 -> Mar 28 instead of correctly Mar 31). */
function clampedMonthDay(year: number, monthIndex: number, dayOfMonth: number): Date {
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(dayOfMonth, daysInMonth)));
}

function nextCalendarMonth(year: number, monthIndex: number): { year: number; monthIndex: number } {
  const m = monthIndex + 1;
  return { year: year + Math.floor(m / 12), monthIndex: m % 12 };
}

function monthlyAtOrAfter(from: Date, dayOfMonth: number): Date {
  const start = startOfUtcDay(from);
  const candidate = clampedMonthDay(start.getUTCFullYear(), start.getUTCMonth(), dayOfMonth);
  if (candidate.getTime() >= start.getTime()) return candidate;
  const next = nextCalendarMonth(start.getUTCFullYear(), start.getUTCMonth());
  return clampedMonthDay(next.year, next.monthIndex, dayOfMonth);
}

/**
 * The due date for an obligation's NEXT cycle.
 * - No prior cycle (`previousDueAt` is null): the first occurrence at or
 *   after the obligation's creation date — a plan created ON its due day
 *   is due immediately, not a full period later.
 * - Otherwise: steps forward from the previous cycle's due date by exactly
 *   one cadence period, so missed/skipped cycles never cause drift — the
 *   next date is always computed from the last SCHEDULED date, not from
 *   "now".
 */
export function computeNextDueAt(cadence: Cadence, previousDueAt: Date | null, obligationCreatedAt: Date): Date {
  if (previousDueAt === null) {
    switch (cadence.kind) {
      case "WEEKLY":
      case "BIWEEKLY":
        return nextWeekdayAtOrAfter(obligationCreatedAt, cadence.dayOfWeek);
      case "MONTHLY":
        return monthlyAtOrAfter(obligationCreatedAt, cadence.dayOfMonth);
    }
  }

  switch (cadence.kind) {
    case "WEEKLY":
      return addDays(previousDueAt, 7);
    case "BIWEEKLY":
      return addDays(previousDueAt, 14);
    case "MONTHLY": {
      const next = nextCalendarMonth(previousDueAt.getUTCFullYear(), previousDueAt.getUTCMonth());
      return clampedMonthDay(next.year, next.monthIndex, cadence.dayOfMonth);
    }
  }
}
