/**
 * Parameterized model resolution against the shared override file.
 *
 * Every cloud image backend (venice / openrouter / openai-codex) had its
 * own copy of this function, differing only in (a) which source tag it
 * calls "its own", (b) the env var name, and (c) the built-in default.
 * This single parameterized version replaces all three. The local backend
 * keeps its own resolver (it reads a different file and checks catalog
 * membership, not source tags).
 *
 * Resolution order:
 *   1. explicit per-call `model` param
 *   2. the shared override file — strip our own `<source>/` tag; on any
 *      OTHER backend's tag, fall through (a stray call to the wrong
 *      backend should use a sensible default, not 404); bare ids pass
 *      through unchanged (legacy)
 *   3. `<envVar>` env var
 *   4. `defaultModel`
 */

import { KNOWN_SOURCES, type ImageSource, readImageModelOverride } from "./override.js";

export interface ResolveModelOptions {
	/** Per-call override (the tool's `model` param). Wins over everything. */
	explicit?: string | null | undefined;
	/** This backend's own source tag, e.g. "venice", "openrouter". */
	ownSource: ImageSource;
	/** Env var read as the next-to-last fallback. */
	envVar: string;
	/** Built-in fallback model id. */
	defaultModel: string;
}

export function resolveModel(opts: ResolveModelOptions): string {
	const { explicit, ownSource, envVar, defaultModel } = opts;
	if (explicit && explicit.length > 0) return explicit;
	const raw = readImageModelOverride();
	if (raw.length > 0) {
		const ownTag = `${ownSource}/`;
		if (raw.startsWith(ownTag)) return raw.slice(ownTag.length);
		const slash = raw.indexOf("/");
		const prefix = slash >= 0 ? raw.slice(0, slash) : "";
		// Another backend's source tag → fall through (don't forward a foreign
		// model id to this backend's API; it would 400/404). A bare id (no
		// slash, or an unknown prefix) passes through unchanged (legacy).
		if (!(prefix && (KNOWN_SOURCES as readonly string[]).includes(prefix))) {
			return raw;
		}
	}
	return process.env[envVar]?.trim() || defaultModel;
}
