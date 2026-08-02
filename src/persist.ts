/**
 * Upload persistence — decode bounded base64 incrementally into the
 * agentchatbox web-servable uploads directory.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";

export const OUTPUT_URL_PREFIX = "/uploads/";
export const DEFAULT_MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const BASE64_CHUNK_CHARS = 1024 * 1024; // divisible by four

export function maxImageBytes(): number {
	const configured = Number.parseInt(process.env.PI_IMAGE_MAX_BYTES ?? "", 10);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_IMAGE_BYTES;
}

export function resolveOutputDir(): string {
	const fromEnv = process.env.ACB_UPLOADS_DIR?.trim();
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return join(process.cwd(), "uploads");
}

export function resolveFormat(format: unknown): { formatId: string; ext: string } {
	const f = (typeof format === "string" ? format : "png").trim().toLowerCase();
	if (f === "webp") return { formatId: "webp", ext: "webp" };
	if (f === "jpeg" || f === "jpg") return { formatId: "jpeg", ext: "jpg" };
	return { formatId: "png", ext: "png" };
}

class InvalidBase64Error extends Error {}

/**
 * Decode and persist one base64 image without allocating a second full-size
 * output buffer or synchronously blocking on a full-file write. Input and
 * decoded sizes are checked before allocation; decoding/writes yield in 1 MiB
 * base64 chunks. Partial files are removed on every error.
 */
export async function writeBase64(
	raw: string,
	outputDir: string,
	ext: string,
): Promise<string | null> {
	const comma = raw.indexOf(",");
	const b64 = (raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw).trim();
	if (!b64 || b64.length % 4 !== 0) return null;
	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	const estimatedBytes = (b64.length / 4) * 3 - padding;
	const limit = maxImageBytes();
	if (estimatedBytes > limit) {
		throw new RangeError(`image exceeds PI_IMAGE_MAX_BYTES (${estimatedBytes} > ${limit})`);
	}

	const filename = `${randomUUID()}.${ext}`;
	const target = join(outputDir, filename);
	const handle = await open(target, "wx", 0o600);
	let written = 0;
	try {
		for (let offset = 0; offset < b64.length; offset += BASE64_CHUNK_CHARS) {
			const end = Math.min(b64.length, offset + BASE64_CHUNK_CHARS);
			const chunk = b64.slice(offset, end);
			const isLast = end === b64.length;
			if (!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk) || (!isLast && chunk.includes("="))) {
				throw new InvalidBase64Error("invalid base64 image");
			}
			const decoded = Buffer.from(chunk, "base64");
			written += decoded.length;
			if (written > limit) throw new RangeError(`image exceeds PI_IMAGE_MAX_BYTES (${written} > ${limit})`);
			await handle.write(decoded);
		}
		await handle.close();
		if (written === 0) {
			await unlink(target).catch(() => {});
			return null;
		}
		return `${OUTPUT_URL_PREFIX}${filename}`;
	} catch (error) {
		await handle.close().catch(() => {});
		await unlink(target).catch(() => {});
		if (error instanceof InvalidBase64Error) return null;
		throw error;
	}
}

export function ensureOutputDir(outputDir: string): void {
	mkdirSync(outputDir, { recursive: true });
}

export async function persistImage(
	entry: unknown,
	outputDir: string,
	ext: string,
): Promise<string | null> {
	if (entry != null && typeof entry === "object") {
		const obj = entry as Record<string, unknown>;
		const url =
			typeof obj.url === "string" ? obj.url : typeof obj.image === "string" ? obj.image : undefined;
		if (url && url.length > 0) return url;
		const data = typeof obj.data === "string" ? obj.data : undefined;
		if (!data) return null;
		return writeBase64(data, outputDir, ext);
	}
	if (typeof entry === "string" && entry.trim().length > 0) {
		return writeBase64(entry, outputDir, ext);
	}
	return null;
}
