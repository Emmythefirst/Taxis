import { describe, expect, it } from "vitest";
import { computeNextDueAt } from "../src/domain/cadence.js";
import type { Cadence } from "../src/domain/types.js";

const iso = (d: Date) => d.toISOString();

describe("computeNextDueAt — first cycle (previousDueAt is null)", () => {
  it("WEEKLY: creation day already matches -> due that same day", () => {
    const cadence: Cadence = { kind: "WEEKLY", dayOfWeek: 3 }; // Wednesday
    const createdAt = new Date("2026-09-02T10:00:00.000Z"); // a Wednesday
    expect(iso(computeNextDueAt(cadence, null, createdAt))).toBe("2026-09-02T00:00:00.000Z");
  });

  it("WEEKLY: creation day doesn't match -> next matching weekday", () => {
    const cadence: Cadence = { kind: "WEEKLY", dayOfWeek: 5 }; // Friday
    const createdAt = new Date("2026-09-02T10:00:00.000Z"); // Wednesday
    expect(iso(computeNextDueAt(cadence, null, createdAt))).toBe("2026-09-04T00:00:00.000Z");
  });

  it("MONTHLY: creation before the target day -> this month", () => {
    const cadence: Cadence = { kind: "MONTHLY", dayOfMonth: 15 };
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    expect(iso(computeNextDueAt(cadence, null, createdAt))).toBe("2026-09-15T00:00:00.000Z");
  });

  it("MONTHLY: creation after the target day -> next month", () => {
    const cadence: Cadence = { kind: "MONTHLY", dayOfMonth: 15 };
    const createdAt = new Date("2026-09-20T00:00:00.000Z");
    expect(iso(computeNextDueAt(cadence, null, createdAt))).toBe("2026-10-15T00:00:00.000Z");
  });
});

describe("computeNextDueAt — stepping forward from a previous due date", () => {
  it("WEEKLY steps by exactly 7 days", () => {
    const cadence: Cadence = { kind: "WEEKLY", dayOfWeek: 3 };
    expect(iso(computeNextDueAt(cadence, new Date("2026-09-02T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z")))).toBe(
      "2026-09-09T00:00:00.000Z",
    );
  });

  it("BIWEEKLY steps by exactly 14 days", () => {
    const cadence: Cadence = { kind: "BIWEEKLY", dayOfWeek: 3 };
    expect(iso(computeNextDueAt(cadence, new Date("2026-09-02T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z")))).toBe(
      "2026-09-16T00:00:00.000Z",
    );
  });

  it("MONTHLY steps to the same configured day next month", () => {
    const cadence: Cadence = { kind: "MONTHLY", dayOfMonth: 15 };
    expect(iso(computeNextDueAt(cadence, new Date("2026-09-15T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z")))).toBe(
      "2026-10-15T00:00:00.000Z",
    );
  });

  it("MONTHLY rolls over the year boundary", () => {
    const cadence: Cadence = { kind: "MONTHLY", dayOfMonth: 15 };
    expect(iso(computeNextDueAt(cadence, new Date("2026-12-15T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z")))).toBe(
      "2027-01-15T00:00:00.000Z",
    );
  });

  it("MONTHLY with dayOfMonth=31 clamps in short months WITHOUT permanently drifting", () => {
    const cadence: Cadence = { kind: "MONTHLY", dayOfMonth: 31 };
    const createdAt = new Date("2026-01-01T00:00:00.000Z");

    const jan = computeNextDueAt(cadence, null, createdAt);
    expect(iso(jan)).toBe("2026-01-31T00:00:00.000Z");

    const feb = computeNextDueAt(cadence, jan, createdAt); // 2026 is not a leap year
    expect(iso(feb)).toBe("2026-02-28T00:00:00.000Z");

    // The critical check: March must resume at 31, not drift to 28 because
    // February's clamped value was used as the basis for the next month.
    const mar = computeNextDueAt(cadence, feb, createdAt);
    expect(iso(mar)).toBe("2026-03-31T00:00:00.000Z");
  });

  it("MONTHLY with dayOfMonth=31 clamps correctly for a leap-year February", () => {
    const cadence: Cadence = { kind: "MONTHLY", dayOfMonth: 31 };
    const jan2028 = new Date("2028-01-31T00:00:00.000Z"); // 2028 is a leap year
    const feb = computeNextDueAt(cadence, jan2028, new Date("2028-01-01T00:00:00.000Z"));
    expect(iso(feb)).toBe("2028-02-29T00:00:00.000Z");
  });
});
