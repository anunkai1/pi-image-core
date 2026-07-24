/**
 * Upload persistence — write image bytes (base64) into the agentchatbox
 * web-servable uploads dir and hand back `/uploads/<uuid>.<ext>` URLs.
 *
 * Identical in every pi-*-image extension before this package existed;
 * this is its single home. Pure fs + Buffer, no pi / fetch deps.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Web-servable URL prefix the agentchatbox server mounts (express.static)
 *  at `/uploads/`. Returned URLs are `/uploads/<uuid>.<ext>`. */
export const OUTPUT_URL_PREFIX = "/uploads/";

/**
 * Web-servable directory the agentchatbox server exposes at `/uploads/`.
 * The server injects it into the pi child env as `ACB_UPLOADS_DIR`
 * (see agentchatbox src/server/pi-process.ts). Image APIs return base64
 * bytes (NOT hosted URLs), so we persist the bytes ourselves and hand back
 * `/uploads/<uuid>.<ext>` URLs the browser can render. Falls back to
 * `<cwd>/uploads` for standalone `pi` runs (no server to serve them, but
 * the files still land somewhere sensible and the URL is stable).
 */
export function resolveOutputDir(): string {
	const fromEnv = process.env.ACB_UPLOADS_DIR?.trim();
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return join(process.cwd(), "uploads");
}

/**
 * Resolve the `format` param to both the API format id and the on-disk file
 * extension. png is the default; jpeg/jpg map to the API id `jpeg` and ext
 * `jpg`; webp passes through. Shared by every backend.
 */
export function resolveFormat(format: unknown): { formatId: string; ext: string } {
	const f = (typeof format === "string" ? format : "png").trim().toLowerCase();
	if (f === "webp") return { formatId: "webp", ext: "webp" };
	if (f === "jpeg" || f === "jpg") return { formatId: "jpeg", ext: "jpg" };
	return { formatId: "png", ext: "png" };
}

/**
 * Decode a base64 image string and write it to `outputDir` as
 * `<uuid>.<ext>`, returning its `/uploads/` URL.
 *
 * Returns null when the input is empty/undecodable (the backend's fault) —
 * the caller reports "no decodable image". THROWS on a filesystem error
 * (our fault) so the agent sees the real cause (e.g. EACCES, ENOSPC)
 * instead of a misleading "no images". `outputDir` must already exist
 * (created once per tool call via ensureOutputDir).
 */
export function writeBase64(raw: string, outputDir: string, ext: string): string | null {
	// Strip an optional `data:image/png;base64,` prefix.
	const comma = raw.indexOf(",");
	const b64 = raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw;
	// Buffer.from(base64) never throws — bad input just yields an empty
	// buffer, which is the "backend gave us nothing" signal.
	const buf = Buffer.from(b64, "base64");
	if (buf.length === 0) return null;
	const filename = `${randomUUID()}.${ext}`;
	writeFileSync(join(outputDir, filename), buf); // intentional: let fs errors surface
	return `${OUTPUT_URL_PREFIX}${filename}`;
}

/** Create the output dir once per tool call. Idempotent. */
export function ensureOutputDir(outputDir: string): void {
	mkdirSync(outputDir, { recursive: true });
}

/**
 * Persist one image entry to disk and return its `/uploads/` URL. Handles
 * the shapes the various backends return: a bare base64 string, or an
 * object with `{ data }` (base64) / `{ url }` / `{ image }` (a hosted URL,
 * passed through untouched). Returns null if the entry has neither
 * decodable bytes nor a URL. THROWS on a disk-write failure — that is a
 * server problem and must surface, not be silently misreported.
 */
export function persistImage(
	entry: unknown,
	outputDir: string,
	ext: string,
): string | null {
	if (entry != null && typeof entry === "object") {
		const obj = entry as Record<string, unknown>;
		const url =
			typeof obj.url === "string" ? obj.url : typeof obj.image === "string" ? obj.image : undefined;
		if (url && url.length > 0) return url;
		const data = typeof obj.data === "string" ? obj.data : undefined;
		if (!data) return null;
		return writeBase64(data, outputDir, ext);
	}
	if (typeof entry === "string" && entry.length > 0) {
		return writeBase64(entry, outputDir, ext);
	}
	return null;
}
