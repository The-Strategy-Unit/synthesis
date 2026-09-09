export function deliveryFailureSignal(
  completed: Promise<void>,
): AbortSignal {
  const controller = new AbortController();
  // Legacy Request.signal also aborts after successful response delivery.
  void completed.catch((error) => controller.abort(error));
  return controller.signal;
}
