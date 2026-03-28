export async function withRetries(action, options = {}) {
  const {
    retries = 3,
    label = "operation",
    delayMs = 1000,
    shouldRetry = () => true
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error)) {
        break;
      }
      await wait(delayMs);
    }
  }

  const message = lastError?.message || "Unknown error";
  throw new Error(`${label} failed after ${retries} attempts: ${message}`);
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

