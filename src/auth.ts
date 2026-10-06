/**
 * Provider auth / API-key resolution.
 *
 * Each backend resolved its key its own way; this is the shared home.
 * All read at CALL time (not module load) so env changes between sessions
 * / systemd restarts are picked up.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Read VENICE_API_KEY at call time. Undefined if unset. */
export function getVeniceKey(): string | undefined {
	const k = process.env.VENICE_API_KEY?.trim();
	return k && k.length > 0 ? k : undefined;
}

/**
 * Read the OpenRouter API key. Tries $OPENROUTER_API_KEY env (ACB injects
 * this) first, then ~/.pi/agent/auth.json's `openrouter` entry (where
 * standalone pi keeps provider keys). Returns undefined if neither is set.
 */
export function getOpenRouterKey(): string | undefined {
	const env = process.env.OPENROUTER_API_KEY?.trim();
	if (env && env.length > 0) return env;
	const fromAuth = readAuthEntry("openrouter");
	if (fromAuth) return fromAuth;
	return undefined;
}

// ── OpenAI Codex / ChatGPT OAuth ──────────────────────────────────

/** Upstream Codex OAuth client id + token endpoint (for refresh). */
export const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

export interface OpenAICodexAuth {
	access: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
}

/** Path to pi's auth store (~/.pi/agent/auth.json — a symlink into the
 *  central secrets store on server2). */
export function authFilePath(): string {
	return join(process.env.HOME ?? homedir(), ".pi", "agent", "auth.json");
}

/** Read one provider's `key` (or bare string) out of auth.json, or undefined. */
function readAuthEntry(provider: string): string | undefined {
	try {
		const file = authFilePath();
		if (!existsSync(file)) return undefined;
		const auth = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const entry = auth[provider];
		if (typeof entry === "string") return entry;
		const key = (entry as { key?: unknown } | undefined)?.key;
		return typeof key === "string" && key.length > 0 ? key : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve/refresh the Codex OAuth token. Refreshes when expiry is within 60s.
 * Persists refreshed access/refresh/expires back to auth.json (the same file
 * pi uses) so future sessions benefit. Returns undefined if no token is
 * configured.
 */
export async function getOpenAICodexAuth(): Promise<OpenAICodexAuth | undefined> {
	const initial = codexEntry(readAuthFile());
	if (!initial) return undefined;
	if (!initial.refresh || (initial.expires ?? 0) > Date.now() + 60_000) return initial;

	// Refresh tokens rotate. Serialize the re-check + network refresh + merge
	// across every pi process using the same auth store, not merely this Node
	// instance. The second waiter observes the first waiter's fresh token and
	// avoids issuing a now-invalid duplicate refresh.
	return withAuthFileLock(async () => {
		const latest = codexEntry(readAuthFile());
		if (!latest) return undefined;
		if (!latest.refresh || (latest.expires ?? 0) > Date.now() + 60_000) return latest;

		const refreshed = await refreshOpenAICodexAuth(latest.refresh);
		// Re-read immediately before persistence and replace only openai-codex,
		// preserving provider keys another process may have added during fetch.
		const currentAuth = readAuthFile();
		if (!currentAuth) return { ...latest, ...refreshed };
		const currentEntry = currentAuth["openai-codex"] as Record<string, unknown> | undefined;
		currentAuth["openai-codex"] = { ...currentEntry, ...refreshed };
		writeAuthFile(currentAuth);
		return {
			access: refreshed.access,
			refresh: refreshed.refresh,
			expires: refreshed.expires,
			accountId: latest.accountId,
		};
	});
}

function codexEntry(auth: Record<string, unknown> | null): OpenAICodexAuth | undefined {
	const entry = auth?.["openai-codex"] as Record<string, unknown> | undefined;
	if (!entry || typeof entry.access !== "string" || entry.access.length === 0) return undefined;
	return {
		access: entry.access,
		refresh: typeof entry.refresh === "string" ? entry.refresh : undefined,
		expires: typeof entry.expires === "number" ? entry.expires : undefined,
		accountId: typeof entry.accountId === "string" ? entry.accountId : undefined,
	};
}

function readAuthFile(): Record<string, unknown> | null {
	try {
		const file = authFilePath();
		if (!existsSync(file)) return null;
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

const AUTH_LOCK_STALE_MS = 2 * 60_000;
const AUTH_LOCK_WAIT_MS = 30_000;

async function withAuthFileLock<T>(fn: () => Promise<T>): Promise<T> {
	const target = realpathSync(authFilePath());
	const lockDir = `${target}.refresh-lock`;
	const deadline = Date.now() + AUTH_LOCK_WAIT_MS;
	while (true) {
		try {
			await mkdir(lockDir, { mode: 0o700 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const age = Date.now() - (await stat(lockDir)).mtimeMs;
				if (age > AUTH_LOCK_STALE_MS) {
					await rm(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() >= deadline) throw new Error("timed out waiting for auth refresh lock");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lockDir, { recursive: true, force: true });
	}
}

function writeAuthFile(auth: Record<string, unknown>): void {
	// auth.json is a symlink into the central secrets store on server2. Resolve
	// it before atomic replacement so token refresh never replaces that symlink
	// with a local, accidentally less-protected copy.
	const file = realpathSync(authFilePath());
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, file);
	} finally {
		rmSync(tmp, { force: true });
	}
}

async function refreshOpenAICodexAuth(
	refreshToken: string,
): Promise<{ access: string; refresh: string; expires: number }> {
	const res = await fetch(OPENAI_CODEX_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`OpenAI Codex token refresh failed (${res.status}): ${text.slice(0, 500)}`);
	}
	const json = (await res.json()) as Record<string, unknown>;
	if (
		typeof json.access_token !== "string" ||
		typeof json.refresh_token !== "string" ||
		typeof json.expires_in !== "number"
	) {
		throw new Error(
			`OpenAI Codex token refresh response missing fields: ${JSON.stringify(json).slice(0, 500)}`,
		);
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + (json.expires_in as number) * 1000,
	};
}
