/**
 * Retry primitives for image-API calls.
 *
 * `sleep` + `withTimeout` were byte-for-byte identical in all four
 * extensions; `callImageApi` collapses the near-identical cloud
 * timeout + retry-on-429/5xx POST loops (callVeniceImage /
 * callOpenRouterImage / callOpenAICodexImage) into one helper:
 *
 *   - caller abort (signal) always propagates immediately, including
 *     mid-backoff
 *   - a hard per-attempt timeout via AbortSignal.timeout, combined with the
 *     caller's signal via AbortSignal.any
 *   - retries 429 + 5xx with exponential backoff (500ms → 1s → 2s, …)
 *   - network errors are NOT retried (a hang retried is still a hang)
 */

/** Sleep that aborts early if the caller signal fires, so cancelling a
 *  backoff wait between retries doesn't stall for the full delay. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

/** Combine the caller's abort signal (user/agent cancel) with a hard
 *  per-attempt timeout into one signal. Node ≥ 20.3 provides AbortSignal.any. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const parts: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
	if (signal) parts.push(signal);
	return AbortSignal.any(parts);
}

export interface CallImageApiOptions {
	url: string;
	headers?: Record<string, string>;
	body: Record<string, unknown>;
	signal: AbortSignal | undefined;
	timeoutMs: number;
	maxRetries: number;
	/** Turn a non-OK response body into a human-readable error message. */
	extractError: (body: unknown, status: number) => string;
	/** Label for the thrown network-error message, e.g. "Venice image". */
	label: string;
}

/**
 * POST one image-generation request with timeout + retry. Returns the parsed
 * JSON body (typed by the caller). Throws on a non-retryable failure or after
 * exhausting retries. Caller aborts always propagate.
 */
export async function callImageApi<T>(opts: CallImageApiOptions): Promise<T> {
	const {
		url,
		headers,
		body,
		signal,
		timeoutMs,
		maxRetries,
		extractError,
		label,
	} = opts;

	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify(body),
				signal: withTimeout(signal, timeoutMs),
			});
		} catch (err) {
			// Caller cancel propagates as-is; network/timeout errors surface
			// immediately without retry.
			if (signal?.aborted) throw err;
			throw new Error(
				`${label} request failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (res.ok) return (await res.json()) as T;

		const text = await res.text().catch(() => "");
		let parsed: unknown = text;
		try {
			parsed = text.length > 0 ? JSON.parse(text) : undefined;
		} catch {
			/* keep as raw text */
		}
		lastError = new Error(extractError(parsed, res.status));
		if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
			await sleep(500 * 2 ** attempt, signal);
			continue;
		}
		throw lastError;
	}
	throw lastError ?? new Error(`${label} request failed`);
}
