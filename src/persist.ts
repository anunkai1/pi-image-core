/**
 * Upload persistence — decode bounded base64 incrementally into the
 * agentchatbox web-servable uploads directory.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export const OUTPUT_URL_PREFIX = "/uploads/";
export const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const UPLOAD_STORAGE_LIMIT_ENV = "AGENTCHATBOX_MAX_UPLOAD_STORAGE_BYTES";
export const UPLOAD_QUOTA_LOCK_DIR = ".acb-upload-quota.lock";
const BASE64_CHUNK_CHARS = 1024 * 1024; // divisible by four
const LOCK_RETRY_MS = 25;
const LOCK_MAX_ATTEMPTS = 400;
const LOCK_STALE_MS = 5 * 60_000;

export function maxImageBytes(): number {
	const configured = Number.parseInt(process.env.PI_IMAGE_MAX_BYTES ?? "", 10);
	return Number.isFinite(configured) && configured > 0
		? configured
		: DEFAULT_MAX_IMAGE_BYTES;
}

/** Null outside ACB; fail closed when ACB supplies a malformed quota. */
export function maxUploadStorageBytes(): number | null {
	const raw = process.env[UPLOAD_STORAGE_LIMIT_ENV]?.trim();
	if (!raw) return null;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${UPLOAD_STORAGE_LIMIT_ENV} must be a positive integer`);
	}
	return value;
}

export function resolveOutputDir(): string {
	const fromEnv = process.env.ACB_UPLOADS_DIR?.trim();
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	return join(process.cwd(), "uploads");
}

export function resolveFormat(format: unknown): {
	formatId: string;
	ext: string;
} {
	const f = (typeof format === "string" ? format : "png").trim().toLowerCase();
	if (f === "webp") return { formatId: "webp", ext: "webp" };
	if (f === "jpeg" || f === "jpg") return { formatId: "jpeg", ext: "jpg" };
	return { formatId: "png", ext: "png" };
}

class InvalidBase64Error extends Error {}

export class UploadStorageQuotaError extends RangeError {
	constructor(
		readonly usedBytes: number,
		readonly requiredBytes: number,
		readonly quotaBytes: number,
	) {
		super(
			`upload storage quota exceeded (${usedBytes} + ${requiredBytes} > ${quotaBytes})`,
		);
		this.name = "UploadStorageQuotaError";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ownerIsGone(lockDir: string): Promise<boolean> {
	try {
		const owner = JSON.parse(
			await readFile(join(lockDir, "owner.json"), "utf8"),
		) as {
			pid?: unknown;
			createdAt?: unknown;
		};
		if (
			typeof owner.pid === "number" &&
			Number.isSafeInteger(owner.pid) &&
			owner.pid > 0
		) {
			try {
				process.kill(owner.pid, 0);
				return false;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "ESRCH";
			}
		}
	} catch {
		/* owner may not have been written yet */
	}
	try {
		return Date.now() - (await stat(lockDir)).mtimeMs > LOCK_STALE_MS;
	} catch {
		return true;
	}
}

async function acquireUploadQuotaLock(
	outputDir: string,
): Promise<() => Promise<void>> {
	const lockDir = join(outputDir, UPLOAD_QUOTA_LOCK_DIR);
	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			await mkdir(lockDir, { mode: 0o700 });
			try {
				await writeFile(
					join(lockDir, "owner.json"),
					JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
					{ mode: 0o600, flag: "wx" },
				);
			} catch (error) {
				await rm(lockDir, { recursive: true, force: true });
				throw error;
			}
			return async () => rm(lockDir, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (await ownerIsGone(lockDir)) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}
			await sleep(LOCK_RETRY_MS);
		}
	}
	throw new Error("timed out waiting for the upload storage quota lock");
}

export async function uploadStorageUsageBytes(
	outputDir: string,
): Promise<number> {
	let total = 0;
	for (const entry of await readdir(outputDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		try {
			total += (await stat(join(outputDir, entry.name))).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return total;
}

/** Serialize extension writers and reserve against ACB's aggregate quota. */
async function withUploadStorageQuota<T>(
	outputDir: string,
	requiredBytes: number,
	operation: () => Promise<T>,
): Promise<T> {
	const quotaBytes = maxUploadStorageBytes();
	if (quotaBytes === null) return operation();
	const release = await acquireUploadQuotaLock(outputDir);
	try {
		const usedBytes = await uploadStorageUsageBytes(outputDir);
		if (usedBytes + requiredBytes > quotaBytes) {
			throw new UploadStorageQuotaError(usedBytes, requiredBytes, quotaBytes);
		}
		return await operation();
	} finally {
		await release();
	}
}

/**
 * Decode and persist one base64 image without allocating a second full-size
 * output buffer or synchronously blocking on a full-file write. Input and
 * decoded sizes are checked before allocation; decoding/writes yield in 1 MiB
 * base64 chunks. Partial files are removed on every error and publication is
 * an atomic rename from a hidden staging file.
 */
export async function writeBase64(
	raw: string,
	outputDir: string,
	ext: string,
): Promise<string | null> {
	const comma = raw.indexOf(",");
	const b64 = (
		raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw
	).trim();
	if (!b64 || b64.length % 4 !== 0) return null;
	const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
	const estimatedBytes = (b64.length / 4) * 3 - padding;
	const limit = maxImageBytes();
	if (estimatedBytes > limit) {
		throw new RangeError(
			`image exceeds PI_IMAGE_MAX_BYTES (${estimatedBytes} > ${limit})`,
		);
	}

	return withUploadStorageQuota(outputDir, estimatedBytes, async () => {
		const filename = `${randomUUID()}.${ext}`;
		const target = join(outputDir, filename);
		const staging = join(outputDir, `.${filename}.${process.pid}.part`);
		const handle = await open(staging, "wx", 0o600);
		let written = 0;
		try {
			for (let offset = 0; offset < b64.length; offset += BASE64_CHUNK_CHARS) {
				const end = Math.min(b64.length, offset + BASE64_CHUNK_CHARS);
				const chunk = b64.slice(offset, end);
				const isLast = end === b64.length;
				if (
					!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk) ||
					(!isLast && chunk.includes("="))
				) {
					throw new InvalidBase64Error("invalid base64 image");
				}
				const decoded = Buffer.from(chunk, "base64");
				written += decoded.length;
				if (written > limit) {
					throw new RangeError(
						`image exceeds PI_IMAGE_MAX_BYTES (${written} > ${limit})`,
					);
				}
				await handle.write(decoded);
			}
			await handle.sync();
			await handle.close();
			if (written === 0) {
				await unlink(staging).catch(() => {});
				return null;
			}
			await rename(staging, target);
			return `${OUTPUT_URL_PREFIX}${filename}`;
		} catch (error) {
			await handle.close().catch(() => {});
			await unlink(staging).catch(() => {});
			if (error instanceof InvalidBase64Error) return null;
			throw error;
		}
	});
}

export function ensureOutputDir(outputDir: string): void {
	mkdirSync(outputDir, { recursive: true, mode: 0o700 });
}

export async function persistImage(
	entry: unknown,
	outputDir: string,
	ext: string,
): Promise<string | null> {
	if (entry != null && typeof entry === "object") {
		const obj = entry as Record<string, unknown>;
		const url =
			typeof obj.url === "string"
				? obj.url
				: typeof obj.image === "string"
					? obj.image
					: undefined;
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
