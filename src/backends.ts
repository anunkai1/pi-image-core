/**
 * The three cloud image-API HTTP wrappers (Venice, OpenRouter, OpenAI Codex).
 *
 * Each is a thin layer over `callImageApi` with its provider-specific
 * endpoint, auth header, and error-body formatting. They live here (not in
 * each extension) so:
 *
 *   - each cloud extension re-exports its wrapper and adds only its
 *     model catalog / defaults on top, and
 *   - `pi-local-image` (the `/imggen` router) imports all three here instead
 *     of MIRRORING them verbatim, which is what it did before this package
 *     existed (the stated reason was "no fragile cross-extension import" —
 *     this package IS that import).
 *
 * Each wrapper reads its own `*_TIMEOUT_MS` / `*_MAX_RETRIES` env vars, so
 * the per-backend knobs keep working unchanged.
 */

import { callImageApi } from "./retry.js";
import type { OpenAICodexAuth } from "./auth.js";

// ── Venice ─────────────────────────────────────────────────────────

export const VENICE_BASE = "https://api.venice.ai/api/v1";
export const VENICE_IMAGE_ENDPOINT = `${VENICE_BASE}/image/generate`;

export interface VeniceImageResponse {
	images?: Array<unknown>;
	id?: string;
	requestId?: string;
}

/** Per-request timeout (VENICE_IMAGE_TIMEOUT_MS, default 120s) + retries
 *  (VENICE_IMAGE_MAX_RETRIES, default 2). */
export const VENICE_REQUEST_TIMEOUT_MS =
	Number.parseInt(process.env.VENICE_IMAGE_TIMEOUT_MS ?? "", 10) || 120_000;
export const VENICE_MAX_RETRIES =
	Math.max(0, Number.parseInt(process.env.VENICE_IMAGE_MAX_RETRIES ?? "", 10) || 2);

/** POST one image-generation request to Venice. Retries 429 + 5xx with
 *  exponential backoff; network errors and caller aborts surface immediately. */
export async function callVeniceImage(
	apiKey: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<VeniceImageResponse> {
	return callImageApi<VeniceImageResponse>({
		url: VENICE_IMAGE_ENDPOINT,
		headers: { Authorization: `Bearer ${apiKey}` },
		body,
		signal,
		timeoutMs: VENICE_REQUEST_TIMEOUT_MS,
		maxRetries: VENICE_MAX_RETRIES,
		label: "Venice image",
		extractError: (parsedBody, status) =>
			`Venice image API ${status}: ${stringifyErrorBody(parsedBody).slice(0, 500)}`,
	});
}

// ── OpenRouter ─────────────────────────────────────────────────────

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const OPENROUTER_IMAGE_ENDPOINT = `${OPENROUTER_BASE}/images`;

export interface OpenRouterImageData {
	b64_json?: string;
	media_type?: string;
	url?: string;
}
export interface OpenRouterImageUsage {
	cost?: number;
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}
export interface OpenRouterImageResponse {
	data?: Array<OpenRouterImageData>;
	usage?: OpenRouterImageUsage;
	created?: number;
}

/** Per-request timeout (OPENROUTER_IMAGE_TIMEOUT_MS, default 180s) + retries. */
export const OPENROUTER_REQUEST_TIMEOUT_MS =
	Number.parseInt(process.env.OPENROUTER_IMAGE_TIMEOUT_MS ?? "", 10) || 180_000;
export const OPENROUTER_MAX_RETRIES =
	Math.max(0, Number.parseInt(process.env.OPENROUTER_IMAGE_MAX_RETRIES ?? "", 10) || 2);

/** POST one image-generation request to OpenRouter's dedicated /images
 *  endpoint. Retries 429 + 5xx. OpenRouter emits a few different error body
 *  shapes; extractOpenRouterError pulls a single human-readable message from
 *  any of them. */
export async function callOpenRouterImage(
	apiKey: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<OpenRouterImageResponse> {
	return callImageApi<OpenRouterImageResponse>({
		url: OPENROUTER_IMAGE_ENDPOINT,
		headers: { Authorization: `Bearer ${apiKey}` },
		body,
		signal,
		timeoutMs: OPENROUTER_REQUEST_TIMEOUT_MS,
		maxRetries: OPENROUTER_MAX_RETRIES,
		label: "OpenRouter image",
		extractError: (parsedBody, status) => extractOpenRouterError(parsedBody, status),
	});
}

/** OpenRouter error bodies come as `{error:{message,code}}`,
 *  `{error:"<string>"}`, `{success:false,error:...}`, or a bare string. */
export function extractOpenRouterError(body: unknown, status: number): string {
	if (body != null && typeof body === "object") {
		const obj = body as Record<string, unknown>;
		const errObj = obj.error;
		if (errObj != null && typeof errObj === "object") {
			const msg = (errObj as Record<string, unknown>).message;
			if (typeof msg === "string" && msg.length > 0) {
				return `OpenRouter ${status}: ${msg.slice(0, 500)}`;
			}
		}
		if (typeof obj.error === "string" && obj.error.length > 0) {
			return `OpenRouter ${status}: ${obj.error.slice(0, 500)}`;
		}
	}
	if (typeof body === "string" && body.length > 0) return `OpenRouter ${status}: ${body.slice(0, 500)}`;
	return `OpenRouter ${status}`;
}

// ── OpenAI Codex / ChatGPT OAuth ───────────────────────────────────

export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const CODEX_IMAGE_GENERATIONS_ENDPOINT = `${CODEX_BASE}/images/generations`;
export const CODEX_IMAGE_EDITS_ENDPOINT = `${CODEX_BASE}/images/edits`;

export interface OpenAICodexImageResponse {
	created?: number;
	background?: string;
	data?: Array<{ b64_json?: string }>;
	output_format?: string;
	quality?: string;
	size?: string;
	usage?: Record<string, unknown>;
}

/** Per-request timeout (OPENAI_CODEX_IMAGE_TIMEOUT_MS, default 180s) + retries. */
export const OPENAI_CODEX_REQUEST_TIMEOUT_MS =
	Number.parseInt(process.env.OPENAI_CODEX_IMAGE_TIMEOUT_MS ?? "", 10) || 180_000;
export const OPENAI_CODEX_MAX_RETRIES =
	Math.max(0, Number.parseInt(process.env.OPENAI_CODEX_IMAGE_MAX_RETRIES ?? "", 10) || 2);

/** POST one image request to Codex's OAuth-backed backend. `kind` selects the
 *  generations vs edits endpoint. Retries 429 + 5xx. The caller resolves the
 *  OAuth token via getOpenAICodexAuth() (which refreshes when near expiry). */
export async function callOpenAICodexImage(
	auth: OpenAICodexAuth,
	kind: "generate" | "edit",
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<OpenAICodexImageResponse> {
	const endpoint =
		kind === "edit" ? CODEX_IMAGE_EDITS_ENDPOINT : CODEX_IMAGE_GENERATIONS_ENDPOINT;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.access}`,
		"OpenAI-Beta": "responses=experimental",
	};
	if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;
	return callImageApi<OpenAICodexImageResponse>({
		url: endpoint,
		headers,
		body,
		signal,
		timeoutMs: OPENAI_CODEX_REQUEST_TIMEOUT_MS,
		maxRetries: OPENAI_CODEX_MAX_RETRIES,
		label: "OpenAI Codex image",
		extractError: (parsedBody, status) => extractOpenAICodexError(parsedBody, status),
	});
}

/** Codex error bodies: `{error:{message}}`, `{error:"<string>"}`,
 *  `{message:"..."}`, or a bare string. */
export function extractOpenAICodexError(body: unknown, status: number): string {
	if (body != null && typeof body === "object") {
		const obj = body as Record<string, unknown>;
		const err = obj.error;
		if (err != null && typeof err === "object") {
			const msg = (err as Record<string, unknown>).message;
			if (typeof msg === "string" && msg.length > 0) {
				return `OpenAI Codex image API ${status}: ${msg.slice(0, 500)}`;
			}
		}
		if (typeof err === "string" && err.length > 0) {
			return `OpenAI Codex image API ${status}: ${err.slice(0, 500)}`;
		}
		if (typeof obj.message === "string" && obj.message.length > 0) {
			return `OpenAI Codex image API ${status}: ${obj.message.slice(0, 500)}`;
		}
	}
	if (typeof body === "string" && body.length > 0) {
		return `OpenAI Codex image API ${status}: ${body.slice(0, 500)}`;
	}
	return `OpenAI Codex image API ${status}`;
}

// ── shared ─────────────────────────────────────────────────────────

/** Stringify a parsed/textual error body for an error message. */
function stringifyErrorBody(body: unknown): string {
	if (typeof body === "string") return body;
	if (body != null) return JSON.stringify(body);
	return "";
}
