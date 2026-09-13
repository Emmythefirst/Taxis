/**
 * Chainlink CRE spike (progress.md Section A.13/A.16): a cron-triggered
 * workflow that calls Taxis's backend on a schedule.
 *
 * Deliberately scoped: this proves CRE can reliably invoke the backend, not
 * that it executes payments. The backend's /cre/trigger-check endpoint
 * currently just confirms receipt (see backend/src/server.ts) — there is no
 * persistence layer yet for it to check real due obligations against, and
 * this cron's 30s test interval must not be confused with the real
 * (monthly-scale) obligation cadence.
 *
 * HTTP capability API confirmed by reading the installed @chainlink/cre-sdk
 * package's own .d.ts files directly (a docs-page example showed a simpler
 * single-argument sendRequest() form that doesn't actually type-check
 * against the Runtime<Config> a cron handler receives — that overload
 * requires NodeRuntime/TeeRuntime instead). The form used here — passing a
 * plain function plus a consensus aggregation strategy — is the one a real
 * generated template (kv-store-ts) actually uses from a cron handler.
 * consensusIdenticalAggregation is used because every DON node calling the
 * same backend with the same secret should get the identical status code
 * back; this is not a value where nodes are expected to independently
 * observe different numbers (contrast with median aggregation for, say, a
 * fetched price).
 */

import {
  consensusIdenticalAggregation,
  CronCapability,
  handler,
  HTTPClient,
  Runner,
  type CronPayload,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";

export type Config = {
  schedule: string;
  backendUrl: string;
};

const callBackend = (sendRequester: HTTPSendRequester, backendUrl: string, secret: string): number => {
  const response = sendRequester
    .sendRequest({
      url: backendUrl,
      method: "POST",
      headers: { "x-cre-secret": secret },
    })
    .result();
  return response.statusCode;
};

export const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  runtime.log(`Cron fired — checking in with Taxis backend at ${runtime.config.backendUrl}`);

  const secret = runtime.getSecret({ id: "CRE_TRIGGER_SECRET" }).result();
  const httpClient = new HTTPClient();

  const statusCode = httpClient
    .sendRequest(runtime, callBackend, consensusIdenticalAggregation<number>())(runtime.config.backendUrl, secret.value)
    .result();

  const message = `Backend responded with status ${statusCode}`;
  runtime.log(message);
  return message;
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();

  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
