/**
 * Small format/conversion helpers shared across the image backends.
 */

import { readFile, stat } from "node:fs/promises";
import { maxImageBytes, resolveOutputDir, OUTPUT_URL_PREFIX } from "./persist.js";

/**
 * Format a USD cost as a short string ($0.034 → "$0.034", $0 → "free",
 * null → ""). OpenRouter's `usage.cost` is the real per-request charge in
 * USD — auto-updated server-side as pricing changes.
 */
export function formatCost(costUsd: number | undefined): string {
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return "";
	if (costUsd === 0) return "free";
	// 4 sig figs is enough to distinguish sub-cent image pricing without
	// trailing-zero noise ($0.0341, not $0.034138750000).
	const rounded = Math.round(costUsd * 10000) / 10000;
	return `$${rounded}`;
}

/** Map an OpenRouter `data[].media_type` (e.g. "image/jpeg") to a file
 *  extension. Returns null when absent or unrecognised — caller falls back
 *  to the requested format's ext. Matters because providers may honour
 *  output_format selectively (Google ignored png and returned jpeg). */
export function extFromMediaType(mediaType: unknown): string | null {
	if (typeof mediaType !== "string") return null;
	const mt = mediaType.trim().toLowerCase();
	if (mt === "image/png") return "png";
	if (mt === "image/jpeg" || mt === "image/jpg") return "jpg";
	if (mt === "image/webp") return "webp";
	if (mt === "image/svg+xml") return "svg";
	return null;
}

/** Map an OpenAI-Codex response `output_format` to an extension, falling
 *  back to `fallbackExt` when absent/unrecognised. */
export function extFromOutputFormat(format: unknown, fallbackExt: string): string {
	const f = typeof format === "string" ? format.trim().toLowerCase() : "";
	if (f === "png") return "png";
	if (f === "jpeg" || f === "jpg") return "jpg";
	if (f === "webp") return "webp";
	return fallbackExt;
}

/** Sniff a MIME type from a filename extension. png default. */
export function sniffMimeType(path: string): string {
	const ext = path.toLowerCase().split(".").pop() ?? "";
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "webp") return "image/webp";
	return "image/png";
}

/**
 * Resolve the `input_image` param (for img2img) into the `url` field an
 * image API expects. Three accepted inputs:
 *   1. `data:...` data URL → used verbatim.
 *   2. `http(s)://...` → used verbatim (the API fetches the URL itself).
 *   3. A local path (including `/uploads/<file>` produced by a previous tool
 *      call) → read from disk, base64, wrap as a data URL.
 * Returns `{ url }` on success or `{ error }` if the path is unreadable.
 */
export async function resolveInputImageUrl(
	input: string,
): Promise<{ url: string } | { error: string }> {
	const s = input.trim();
	if (s.length === 0) return { error: "empty input_image" };
	if (s.startsWith("data:")) {
		const comma = s.indexOf(",");
		if (comma < 0 || !/;base64$/i.test(s.slice(0, comma))) {
			return { error: "input_image data URL must contain base64 data" };
		}
		const estimatedBytes = Math.floor((s.length - comma - 1) * 0.75);
		const limit = maxImageBytes();
		if (estimatedBytes > limit) {
			return { error: `input_image exceeds PI_IMAGE_MAX_BYTES (${estimatedBytes} > ${limit})` };
		}
		return { url: s };
	}
	if (/^https?:\/\//i.test(s)) return { url: s };
	// Local path. `/uploads/...` is served from ACB_UPLOADS_DIR.
	let diskPath = s;
	if (s.startsWith(OUTPUT_URL_PREFIX)) {
		const uploadsDir = resolveOutputDir();
		diskPath = join(uploadsDir, s.slice(OUTPUT_URL_PREFIX.length));
	}
	try {
		const info = await stat(diskPath);
		if (!info.isFile()) return { error: `input_image is not a regular file: ${s}` };
		const limit = maxImageBytes();
		if (info.size > limit) {
			return { error: `input_image exceeds PI_IMAGE_MAX_BYTES (${info.size} > ${limit})` };
		}
		const buf = await readFile(diskPath);
		const mt = sniffMimeType(diskPath);
		return { url: `data:${mt};base64,${buf.toString("base64")}` };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { error: `input_image not found: ${s}` };
		}
		return {
			error: `could not read input_image ${s}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/** Extract the actual model id from a unified-picker option string. Display
 *  names can contain parentheses (e.g. "Nano Banana (Gemini 2.5 Flash Image)"),
 *  so use the FINAL parenthesized segment before ` — `, not the first one.
 *  Returns undefined when no trailing id is present. */
export function modelIdFromPickerOption(option: string): string | undefined {
	const label = option.split(" — ", 1)[0];
	const match = label.match(/\(([^()]*)\)\s*$/);
	const id = match?.[1]?.trim();
	return id || undefined;
}

// join is used by resolveInputImageUrl above; imported here so the function
// is self-contained.
import { join } from "node:path";
