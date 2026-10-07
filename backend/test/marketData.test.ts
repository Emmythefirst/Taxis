import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveMarketDataProvider } from "../src/pricing/marketData.js";

/**
 * liveMarketDataProvider() fails safe, never loud (see its own header):
 * this is the regression coverage for that contract — a fetch failure (no
 * internet at a demo venue, the API rate-limiting, a malformed response)
 * must never throw, and must never silently invent a number either. It
 * either serves the real last-known rate or the explicit DEMO_FX_RATE
 * fallback, nothing in between.
 */

const originalFetch = global.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("liveMarketDataProvider", () => {
  it("serves real per-currency rates once the initial background fetch resolves", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: "success", rates: { NGN: 1328.1, GHS: 11.6 } }),
    })) as unknown as typeof fetch;

    const market = liveMarketDataProvider();
    await vi.advanceTimersByTimeAsync(0);

    expect(market.getFxRate("NGN")).toBeCloseTo(1328.1);
    expect(market.getFxRate("GHS")).toBeCloseTo(11.6);
    // USD/AUSD are always hardcoded 1:1 — never read from the fetched map,
    // same rule staticMarketDataProvider already followed.
    expect(market.getFxRate("USD")).toBe(1);
    expect(market.getFxRate("AUSD")).toBe(1);
  });

  it("falls back to DEMO_FX_RATE when the fetch fails and nothing has ever succeeded", async () => {
    vi.stubEnv("DEMO_FX_RATE", "1234");
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const market = liveMarketDataProvider();
    await vi.advanceTimersByTimeAsync(0);

    expect(market.getFxRate("NGN")).toBe(1234);
  });

  it("treats a non-success API result body as a failure, not a crash", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: "error" }),
    })) as unknown as typeof fetch;

    const market = liveMarketDataProvider();
    await vi.advanceTimersByTimeAsync(0);

    expect(market.getFxRate("NGN")).toBe(1500); // DEMO_FX_RATE's own default
  });

  it("keeps the last known live rate if a LATER background refresh fails, rather than reverting to the static fallback", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ result: "success", rates: { NGN: 1500 } }) } as unknown as Response;
      }
      throw new Error("transient outage");
    }) as unknown as typeof fetch;

    const market = liveMarketDataProvider();
    await vi.advanceTimersByTimeAsync(0);
    expect(market.getFxRate("NGN")).toBe(1500);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1); // crosses the refresh interval — triggers the failing second call
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(market.getFxRate("NGN")).toBe(1500); // unchanged — not reverted to DEMO_FX_RATE
  });

  it("fees stay the operator-set env values regardless of FX source — never fetched externally", async () => {
    vi.stubEnv("DEMO_FEE_AGENT_AUSD", "2.5");
    vi.stubEnv("DEMO_FEE_NETWORK_AUSD", "0.75");
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: "success", rates: { NGN: 1500 } }),
    })) as unknown as typeof fetch;

    const market = liveMarketDataProvider();
    await vi.advanceTimersByTimeAsync(0);

    expect(market.getFees()).toEqual({ agentAusd: 2.5, networkAusd: 0.75 });
  });
});
