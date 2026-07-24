/**
 * Retry primitives for image-API calls.
 *
 * `sleep` + `withTimeout` were byte-for-byte identical in all four
 * extensions; `callImageApi` collapses the four near-identical
 * timeout + retry-on-429/5xx POST loops (callVeniceImage /
 * callOpenRouterImage / callOpenAICodexImage / callLocalImage) into one
 * parameterized helper. Behavior is preserved exactly:
 *
 *   - caller abort (signal) always propagates immediately, including
 *     mid-backoff
 *   - a hard per-attempt timeout via AbortSignal.timeout, combined with the
 *     caller's signal via AbortSignal.any
 *   - retries 429 + 5xx with exponential backoff (500ms → 1s → 2s, …)
 *   - network errors are NOT retried by default (a hang retried is still a
 *     hang) — set `retryNetworkErrors` for the local GPU server, where a
 *     network error often means the server is mid-restart and will recover
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
	/** Base delay (ms) for exponential backoff: 500ms, 1s, 2s, … Default 500. */
	backoffBaseMs?: number;
	/** Retry on a thrown fetch error (network/timeout)? Default false. The
	 *  local GPU server sets this true (a restart looks like a network error
	 *  that clears); the cloud backends surface immediately. */
	retryNetworkErrors?: boolean;
	/** Which HTTP statuses are retryable. Default: 429 or >= 500. The local
	 *  server also retries 409 (wrong-instance, mid-zimage-switch). */
	isRetryableStatus?: (status: number) => boolean;
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
		backoffBaseMs = 500,
		retryNetworkErrors = false,
		isRetryableStatus = (status) => status === 429 || status >= 500,
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
			// Caller cancel: propagate without retry.
			if (signal?.aborted) throw err;
			lastError = new Error(
				`${label} request failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			// Network/timeout error: surface immediately unless the caller opted
			// into retrying it (local server mid-restart).
			if (retryNetworkErrors && attempt < maxRetries) {
				await sleep(backoffBaseMs * 2 ** attempt, signal);
				continue;
			}
			throw lastError;
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
		if (isRetryableStatus(res.status) && attempt < maxRetries) {
			await sleep(backoffBaseMs * 2 ** attempt, signal);
			continue;
		}
		throw lastError;
	}
	throw lastError ?? new Error(`${label} request failed`);
}
