/**
 * The UNIFIED image-model override file + source tagging.
 *
 * `~/.config/acb/image-model` is the single per-user override the
 * agentchatbox `/imagemodel` picker writes (owned by pi-local-image) and
 * that EVERY image backend reads at call time so a live picker change takes
 * effect without respawning pi. ACB's `/api/health` also reads it to label
 * the Settings row.
 *
 * Values are SOURCE-TAGGED: `local/<id>`, `venice/<id>`, `openrouter/<id>`,
 * or `openai-codex/<id>`. Each backend's `resolveModel()` honours its OWN
 * tag (strips the prefix) and falls through on the others (so a stray call
 * to the wrong backend uses a sensible default instead of 404'ing against a
 * model id that lives on another backend). See `resolve.ts`.
 *
 * NOTE on OpenRouter ids: they contain their own `vendor/` slash
 * (`google/gemini-3-pro-image`), so a tagged OpenRouter id has TWO slashes
 * (`openrouter/google/gemini-3-pro-image`). The tag helpers split on the
 * FIRST slash, so they handle this correctly.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The four backends that write/read the shared override file. */
export type ImageSource = "local" | "venice" | "openrouter" | "openai-codex";

/** All known source tags (used to tell "another backend's tag" from a bare id). */
export const KNOWN_SOURCES: readonly ImageSource[] = [
	"local",
	"venice",
	"openrouter",
	"openai-codex",
];

/**
 * Path to the shared override file. Resolved lazily (per call) from HOME so
 * a HOME change after module load is honored.
 */
export function imageModelOverrideFile(): string {
	return join(process.env.HOME ?? homedir(), ".config", "acb", "image-model");
}

/**
 * Read the raw trimmed contents of the override file, or "" if absent /
 * unreadable. Callers that need to distinguish "missing" from "empty" can
 * use existsSync on imageModelOverrideFile() directly.
 */
export function readImageModelOverride(): string {
	try {
		const file = imageModelOverrideFile();
		if (existsSync(file)) return readFileSync(file, "utf8").trim();
	} catch {
		/* fall through */
	}
	return "";
}

/**
 * Persist (or clear) the user's image-model override atomically
 * (tmp + rename). Called by the /imagemodel picker. `null` removes the file.
 */
export function persistImageModelOverride(modelId: string | null): void {
	const file = imageModelOverrideFile();
	mkdirSync(join(file, ".."), { recursive: true });
	if (modelId === null) {
		rmSync(file, { force: true });
		return;
	}
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${modelId}\n`, "utf8");
	renameSync(tmp, file);
}

/**
 * Tag a bare model id with its source so the shared override file carries
 * origin information. Idempotent — already-tagged values pass through.
 * `classifier(id) → source` is caller-supplied so this module doesn't need
 * to know the per-backend catalogs (avoids a catalogs→override cycle); pass
 * `imageModelSourceFor(id)` from catalogs.ts, or a custom classifier.
 *
 * Unknown ids default to `venice/` (preserves legacy behaviour — pre-tagging,
 * every id was implicitly a Venice id).
 */
export function tagImageModelId(
	id: string,
	classifier: (id: string) => ImageSource = () => "venice",
): string {
	if (KNOWN_SOURCES.some((s) => id.startsWith(`${s}/`))) return id; // already tagged
	const source = classifier(id);
	return `${source}/${id}`;
}

/**
 * Strip a `local/`, `venice/`, `openrouter/`, or `openai-codex/` prefix,
 * returning the bare catalog id. Splits on the FIRST slash so OpenRouter ids
 * (which contain their own `vendor/` slash) untag correctly:
 * `openrouter/google/foo` → `google/foo`. Bare input passes through
 * unchanged; unknown prefixes pass through as-is.
 */
export function untagImageModelId(tagged: string): string {
	const slash = tagged.indexOf("/");
	if (slash < 0) return tagged;
	const prefix = tagged.slice(0, slash);
	if (KNOWN_SOURCES.includes(prefix as ImageSource)) return tagged.slice(slash + 1);
	return tagged; // unknown prefix — return as-is
}

/**
 * Return the source prefix of a tagged id, or `"venice"` for a bare id
 * (legacy default). Used by ACB's panel to render the provider column
 * without needing the model catalogs.
 */
export function imageModelSource(tagged: string): ImageSource {
	const slash = tagged.indexOf("/");
	if (slash < 0) return "venice";
	const prefix = tagged.slice(0, slash);
	if (KNOWN_SOURCES.includes(prefix as ImageSource)) return prefix as ImageSource;
	return "venice";
}
