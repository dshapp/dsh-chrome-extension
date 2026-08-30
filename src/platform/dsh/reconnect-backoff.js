// DSH 指数退避重连:500ms 起、×2、上限 10s,带抖动。
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10000;

export function createReconnectBackoff(options = {}) {
  const base = options.baseDelayMs ?? BASE_DELAY_MS;
  const max = options.maxDelayMs ?? MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  let attempt = 0;

  return Object.freeze({
    next() {
      const exponential = Math.min(base * 2 ** attempt, max);
      attempt += 1;
      return Math.round(exponential / 2 + random() * exponential / 2);
    },
    reset() {
      attempt = 0;
    },
    get attempts() {
      return attempt;
    }
  });
}
