/**
 * The per-backend image-model catalogs + classifiers.
 *
 * SINGLE SOURCE OF TRUTH. Previously pi-venice-image owned the Venice list,
 * pi-openrouter-image owned the OpenRouter list, pi-openai-codex-image owned
 * the Codex list — and pi-local-image MIRRORED all three (plus its own local
 * list) verbatim so it could render a unified `/imagemodel` picker "without a
 * fragile cross-extension import". Now every extension imports its list from
 * here, and pi-local-image imports all four. Adding/removing a model is a
 * one-line edit in one place.
 *
 * `imageModelSourceFor(id)` classifies a bare id into its backend; the
 * override-file tagger (override.ts) uses it so `~/.config/acb/image-model`
 * carries correct origin info.
 */

import type { ImageSource } from "./override.js";

/** A backend-agnostic catalog entry. The local catalog adds a `port` field. */
export interface ImageModelEntry {
	id: string;
	name: string;
	tags: readonly string[];
}

/** ── Venice (cloud API) ────────────────────────────────────────────
 *  IDs from `GET https://api.venice.ai/api/v1/models?type=image`. */
export const VENICE_IMAGE_MODELS: readonly ImageModelEntry[] = [
	{ id: "flux-3-image", name: "Flux 3", tags: ["flagship", "flux", "latest"] },
	{ id: "flux-2-max", name: "Flux 2 Max", tags: ["flux", "photoreal"] },
	{ id: "flux-2-pro", name: "Flux 2 Pro", tags: ["pro", "flux"] },
	{ id: "gpt-image-2-6-sunburst", name: "GPT Image 2.6 Sunburst", tags: ["openai", "latest"] },
	{ id: "gpt-image-2-6-flare", name: "GPT Image 2.6 Flare", tags: ["openai", "latest"] },
	{ id: "gpt-image-2-5-sunburst", name: "GPT Image 2.5 Sunburst", tags: ["openai"] },
	{ id: "gpt-image-2-5-flare", name: "GPT Image 2.5 Flare", tags: ["openai"] },
	{ id: "gpt-image-2", name: "GPT Image 2", tags: ["openai"] },
	{ id: "gpt-image-1-5", name: "GPT Image 1.5", tags: ["openai"] },
	{ id: "grok-imagine-image-2-0", name: "Grok Imagine 2.0", tags: ["grok", "latest"] },
	{ id: "grok-imagine-image", name: "Grok Imagine", tags: ["grok"] },
	{ id: "nano-banana-2-1", name: "Nano Banana 2.1", tags: ["google", "latest"] },
	{ id: "nano-banana-pro", name: "Nano Banana Pro", tags: ["google", "pro"] },
	{ id: "nano-banana-2", name: "Nano Banana 2", tags: ["google"] },
	{ id: "nano-banana-2-lite", name: "Nano Banana 2 Lite", tags: ["google", "lite", "cheap"] },
	{ id: "ideogram-v4-5", name: "Ideogram V4.5", tags: ["ideogram", "typography", "latest"] },
	{ id: "ideogram-v4", name: "Ideogram V4", tags: ["ideogram", "typography"] },
	{ id: "kling-v4-text-to-image", name: "Kling Image 4.0", tags: ["kling", "latest"] },
	{ id: "krea-3", name: "Krea 3", tags: ["krea", "latest"] },
	{ id: "luma-uni-1-max", name: "Luma Uni-1 Max", tags: ["luma", "max"] },
	{ id: "mai-image-2-7", name: "MAI Image 2.7", tags: ["mai", "latest"] },
	{ id: "mai-image-2-7-flash", name: "MAI Image 2.7 Flash", tags: ["mai", "fast"] },
	{ id: "minimax-h3-image", name: "MiniMax H3 Image", tags: ["minimax"] },
	{ id: "muse-image", name: "Muse Image", tags: ["muse", "creative"] },
	{ id: "qwen-image-3-pro", name: "Qwen Image 3 Pro", tags: ["qwen", "pro", "latest"] },
	{ id: "qwen-image-3", name: "Qwen Image 3", tags: ["qwen", "latest"] },
	{ id: "qwen-image-2-1-pro", name: "Qwen Image 2.1 Pro", tags: ["qwen", "pro"] },
	{ id: "qwen-image-2-1-turbo", name: "Qwen Image 2.1 Turbo", tags: ["qwen", "turbo"] },
	{ id: "qwen-image-2-pro", name: "Qwen Image 2 Pro", tags: ["qwen", "pro"] },
	{ id: "qwen-image-2", name: "Qwen Image 2", tags: ["qwen"] },
	{ id: "qwen-image", name: "Qwen Image", tags: ["qwen", "kidstories"] },
	{ id: "recraft-v4-pro", name: "Recraft V4 Pro", tags: ["recraft", "pro", "vector"] },
	{ id: "recraft-v4", name: "Recraft V4", tags: ["recraft", "vector"] },
	{ id: "seedream-v5-5", name: "Seedream V5.5", tags: ["seedream", "latest"] },
	{ id: "seedream-v5-pro", name: "Seedream V5 Pro", tags: ["seedream", "pro"] },
	{ id: "wan-2-7-pro-text-to-image", name: "Wan 2.7 Pro T2I", tags: ["wan", "pro"] },
	{ id: "hunyuan-image-v3", name: "Hunyuan Image 3.0", tags: ["hunyuan"] },
	{ id: "z-image-turbo", name: "Z-Image Turbo", tags: ["turbo", "fast", "kidstories"] },
];

/** ── OpenRouter (dedicated /images API) ───────────────────────────
 *  Live image-output models from OpenRouter (`GET /api/v1/models`, filtered to
 *  image-output models; openrouter/auto routing meta-models excluded).
 *  IDs carry a `vendor/` prefix (UNLIKE Venice/local bare ids). Every
 *  OpenRouter image model accepts image input (img2img). */
export const OPENROUTER_IMAGE_MODELS: readonly ImageModelEntry[] = [
	{ id: "google/gemini-3.1-flash-image", name: "Nano Banana 2 (Gemini 3.1 Flash Image)", tags: ["google", "balanced"] },
	{ id: "google/gemini-nano-banana-2.1", name: "Nano Banana 2.1", tags: ["google", "latest"] },
	{ id: "google/gemini-3.1-flash-lite-image", name: "Nano Banana 2 Lite (3.1 Flash Image)", tags: ["google", "cheap"] },
	{ id: "google/gemini-2.5-flash-image", name: "Nano Banana (Gemini 2.5 Flash Image)", tags: ["google", "balanced"] },
	{ id: "google/gemini-3-pro-image", name: "Nano Banana Pro (Gemini 3 Pro Image)", tags: ["google", "flagship"] },
	{ id: "openai/gpt-5.4-image-2", name: "GPT-5.4 Image 2", tags: ["openai", "new"] },
	{ id: "google/gemini-3-pro-image-preview", name: "Nano Banana Pro Preview (3 Pro Image)", tags: ["google", "flagship", "preview"] },
	{ id: "google/gemini-3.1-flash-image-preview", name: "Nano Banana 2 Preview (3.1 Flash Image)", tags: ["google", "preview"] },
	{ id: "openai/gpt-5-image-mini", name: "GPT-5 Image Mini", tags: ["openai", "mini"] },
	{ id: "openai/gpt-5-image", name: "GPT-5 Image", tags: ["openai"] },
];

/** ── OpenAI Codex / ChatGPT OAuth ────────────────────────────────
 *  Only one picker model: upstream Codex's built-in imagegen fixes
 *  `gpt-image-2` (the backend may return gpt-image-2-codex/auto metadata). */
export const OPENAI_CODEX_IMAGE_MODELS: readonly ImageModelEntry[] = [
	{ id: "gpt-image-2", name: "GPT Image 2 (Codex/ChatGPT OAuth)", tags: ["openai", "codex", "oauth"] },
];

/** Local GPU catalogue. Port 0 denotes guarded one-shot CLI generation. */
export interface LocalModelEntry extends ImageModelEntry {
	port: number;
}

export const LOCAL_MODELS: readonly LocalModelEntry[] = [
	{ id: "qwen-image-2.1-local", name: "Qwen Image 2.1 Turbo", port: 0, tags: ["qwen", "local", "uncensored", "1024px"] },
];

// ── Classifiers ────────────────────────────────────────────────────

/** Only models installed on Server4 are classified as local. */
export function isLocalModel(id: string): boolean {
	return LOCAL_MODELS.some((m) => m.id === id);
}
export function isVeniceModel(id: string): boolean {
	return VENICE_IMAGE_MODELS.some((m) => m.id === id);
}
export function isOpenRouterModel(id: string): boolean {
	return OPENROUTER_IMAGE_MODELS.some((m) => m.id === id);
}
export function isOpenAICodexModel(id: string): boolean {
	return OPENAI_CODEX_IMAGE_MODELS.some((m) => m.id === id);
}

/**
 * Classify a bare model id into its backend. Used by the override-file
 * tagger (override.ts tagImageModelId) so the shared file carries correct
 * origin info. OpenRouter ids are vendor-prefixed (contain `/`), so they
 * never collide with the bare Venice/local ids. Unknown ids default to `venice` (legacy).
 */
export function imageModelSourceFor(id: string): ImageSource {
	if (isLocalModel(id)) return "local";
	if (isOpenRouterModel(id)) return "openrouter";
	if (isOpenAICodexModel(id)) return "openai-codex";
	return "venice";
}
