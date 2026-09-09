import assert from "node:assert/strict";

import { deliveryFailureSignal } from "./request_completion.ts";

Deno.test("successful response delivery does not cancel request work", async () => {
  let resolveCompleted: () => void = () => {};
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  const signal = deliveryFailureSignal(completed);

  resolveCompleted();
  await completed;

  assert.equal(signal.aborted, false);
});

Deno.test("failed response delivery cancels request work", async () => {
  let rejectCompleted: (error: Error) => void = () => {};
  const completed = new Promise<void>((_resolve, reject) => {
    rejectCompleted = reject;
  });
  const signal = deliveryFailureSignal(completed);
  const failure = new Error("client disconnected");

  rejectCompleted(failure);
  await completed.catch(() => {});

  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, failure);
});
