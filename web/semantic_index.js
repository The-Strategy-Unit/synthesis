export const SEMANTIC_REBUILD_BATCH_SIZE = 20;

function validateStatus(status) {
  if (
    !status || typeof status !== "object" ||
    !Number.isSafeInteger(status.processed) || status.processed < 0 ||
    !Number.isSafeInteger(status.embedded) || status.embedded < 0 ||
    !Number.isSafeInteger(status.total) || status.total < status.embedded ||
    !Number.isSafeInteger(status.remaining) || status.remaining < 0 ||
    status.remaining !== status.total - status.embedded ||
    typeof status.complete !== "boolean" ||
    status.complete !== (status.remaining === 0)
  ) {
    throw new Error("Semantic index rebuild returned invalid progress");
  }
  return status;
}

export async function buildCompleteSemanticIndex(
  runBatch,
  { shouldStop = () => false, onProgress = () => {} } = {},
) {
  if (typeof runBatch !== "function") {
    throw new TypeError("Semantic index batch runner must be a function");
  }

  let status = null;
  let previousEmbedded = -1;
  while (!shouldStop()) {
    status = validateStatus(await runBatch(SEMANTIC_REBUILD_BATCH_SIZE));
    onProgress(status);
    if (status.complete) return { status, stopped: false };
    if (status.processed === 0 || status.embedded <= previousEmbedded) {
      throw new Error("Semantic index rebuild made no progress");
    }
    previousEmbedded = status.embedded;
  }

  return { status, stopped: true };
}
