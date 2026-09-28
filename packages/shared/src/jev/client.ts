/**
 * Minimal client for TypeSafe AI's Jev ("System One" decision model): typed
 * questions in, calibrated typed answers out — no generated text.
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer $TYPESAFE_API_KEY
 *
 * Three question types: `noul` (yes/no → probability of true), `choice`
 * (≤255 options → pick + distribution + confidence), `score` (2–10 rubric
 * levels → expected level + distribution + confidence). All questions in one
 * request are answered in parallel, so asking several costs little more than
 * asking one. Limits (per the TypeSafe docs): 32k tokens for state + the
 * longest question, 64k for state + all questions.
 *
 * Optional layer: `jevApiKey()` is undefined without TYPESAFE_API_KEY and every
 * caller skips Jev entirely.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_MAX_CHOICE_OPTIONS = 255;
export const JEV_MAX_SCORE_LEVELS = 10;

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface JevRequest {
  apiKey: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  model?: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries on 429 / 529 / network errors (exponential backoff). */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

/** The TypeSafe key, or undefined (layer off). `||`: an unset workflow secret arrives as "". */
export function jevApiKey(): string | undefined {
  return process.env.TYPESAFE_API_KEY || undefined;
}

/** Throws on a question the API would reject (422), before spending a request. */
export function validateJevQuestions(questions: Record<string, JevQuestion>): void {
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const n = Object.keys(q.criteria).length;
      if (n < 2 || n > JEV_MAX_CHOICE_OPTIONS) {
        throw new Error(`jev: choice '${name}' has ${n} options (2–${JEV_MAX_CHOICE_OPTIONS})`);
      }
    } else if (q.type === "score") {
      const n = q.criteria.length;
      if (n < 2 || n > JEV_MAX_SCORE_LEVELS) {
        throw new Error(`jev: score '${name}' has ${n} levels (2–${JEV_MAX_SCORE_LEVELS})`);
      }
    }
  }
}

const RETRYABLE = new Set([429, 529, 502, 503]);

export async function askJev(req: JevRequest): Promise<JevResponse> {
  validateJevQuestions(req.questions);
  const doFetch = req.fetchImpl ?? fetch;
  const maxRetries = req.maxRetries ?? 3;
  const body = JSON.stringify({ model: req.model ?? JEV_DEFAULT_MODEL, state: req.state, questions: req.questions });
  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    let res: Response;
    try {
      res = await doFetch(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${req.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(req.timeoutMs ?? 20_000),
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (res.ok) return (await res.json()) as JevResponse;
    const text = (await res.text().catch(() => "")).slice(0, 300);
    lastError = `HTTP ${res.status}${text ? `: ${text}` : ""}`;
    if (!RETRYABLE.has(res.status)) break;
  }
  throw new Error(`jev request failed: ${lastError}`);
}

/**
 * Confidence of an answer on a 0..1 scale. Choice/score carry the API's own
 * calibrated confidence; a yes/no carries only P(true), so its confidence is
 * the probability of whichever side it landed on.
 */
export function jevConfidence(answer: JevAnswer): number {
  return answer.type === "noul" ? Math.max(answer.noul, 1 - answer.noul) : answer.confidence;
}
