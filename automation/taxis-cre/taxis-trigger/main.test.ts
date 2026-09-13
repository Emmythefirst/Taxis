import { describe, expect } from "bun:test";
import { test } from "@chainlink/cre-sdk/test";
import { initWorkflow } from "./main";
import type { Config } from "./main";

// onCronTrigger's actual behavior (calling the Taxis backend over HTTP with
// a secret) is deliberately validated via `cre workflow simulate` against a
// real running backend instead of a mocked unit test here — see
// progress.md's CRE spike entry. A unit test mocking CRE's HTTP-actions and
// secrets capabilities precisely would add real uncertainty of its own
// (exact internal shapes weren't found documented or exemplified anywhere
// in the installed SDK) without proving any more than the live simulation
// already does.

describe("initWorkflow", () => {
  test("returns one handler with the configured cron schedule", async () => {
    const testSchedule = "*/30 * * * * *";
    const config: Config = { schedule: testSchedule, backendUrl: "http://localhost:8787/cre/trigger-check" };

    const handlers = initWorkflow(config);

    expect(handlers).toBeArray();
    expect(handlers).toHaveLength(1);
    expect(handlers[0].trigger.config.schedule).toBe(testSchedule);
  });
});
