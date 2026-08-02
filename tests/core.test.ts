import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	OUTPUT_URL_PREFIX,
	resolveFormat,
	resolveOutputDir,
	writeBase64,
	ensureOutputDir,
	persistImage,
	resolveModel,
	tagImageModelId,
	untagImageModelId,
	imageModelSource,
	imageModelSourceFor,
	formatCost,
	extFromMediaType,
	extFromOutputFormat,
} from "../src/index.js";

let tmpHome: string;
const origHome = process.env.HOME;
const origUploads = process.env.ACB_UPLOADS_DIR;
const origMaxImageBytes = process.env.PI_IMAGE_MAX_BYTES;

beforeEach(async () => {
	tmpHome = await mkdtemp(join(tmpdir(), "pi-image-core-home-"));
	process.env.HOME = tmpHome;
	delete process.env.ACB_UPLOADS_DIR;
});

afterEach(async () => {
	process.env.HOME = origHome;
	if (origUploads === undefined) delete process.env.ACB_UPLOADS_DIR;
	else process.env.ACB_UPLOADS_DIR = origUploads;
	if (origMaxImageBytes === undefined) delete process.env.PI_IMAGE_MAX_BYTES;
	else process.env.PI_IMAGE_MAX_BYTES = origMaxImageBytes;
	await rm(tmpHome, { recursive: true, force: true });
});

describe("resolveFormat", () => {
	it("defaults to png", () => {
		expect(resolveFormat(undefined)).toEqual({ formatId: "png", ext: "png" });
		expect(resolveFormat("garbage")).toEqual({ formatId: "png", ext: "png" });
	});
	it("maps jpeg/jpg to the API id 'jpeg' and ext 'jpg'", () => {
		expect(resolveFormat("jpeg")).toEqual({ formatId: "jpeg", ext: "jpg" });
		expect(resolveFormat("JPG")).toEqual({ formatId: "jpeg", ext: "jpg" });
	});
	it("passes webp through", () => {
		expect(resolveFormat("webp")).toEqual({ formatId: "webp", ext: "webp" });
	});
});

describe("writeBase64 + persistImage", () => {
	it("writes a base64 string to a /uploads/<uuid>.png url", async () => {
		const dir = await mkdtemp(join(tmpdir(), "out-"));
		const url = await writeBase64("aGVsbG8=", dir, "png"); // "hello"
		expect(url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/);
		await rm(dir, { recursive: true, force: true });
	});
	it("strips a data: prefix", async () => {
		const dir = await mkdtemp(join(tmpdir(), "out-"));
		const url = await writeBase64("data:image/png;base64,aGVsbG8=", dir, "png");
		expect(url).toMatch(/^\/uploads\//);
		await rm(dir, { recursive: true, force: true });
	});
	it("returns null on empty/undecodable input", async () => {
		expect(await writeBase64("", "/tmp", "png")).toBeNull();
		expect(await writeBase64("!!!notbase64!!!", "/tmp", "png")).toBeNull();
	});
	it("persistImage handles {data} objects and bare strings", async () => {
		const dir = await mkdtemp(join(tmpdir(), "out-"));
		expect(await persistImage({ data: "aGVsbG8=" }, dir, "png")).toMatch(/^\/uploads\//);
		expect(await persistImage("aGVsbG8=", dir, "png")).toMatch(/^\/uploads\//);
		expect(await persistImage({}, dir, "png")).toBeNull();
		expect(await persistImage(null, dir, "png")).toBeNull();
		await rm(dir, { recursive: true, force: true });
	});
	it("rejects decoded images above the configured byte limit before writing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "out-"));
		process.env.PI_IMAGE_MAX_BYTES = "4";
		await expect(writeBase64("aGVsbG8=", dir, "png")).rejects.toThrow(/PI_IMAGE_MAX_BYTES/);
		expect(await import("node:fs/promises").then(({ readdir }) => readdir(dir))).toEqual([]);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("resolveOutputDir", () => {
	it("reads ACB_UPLOADS_DIR when set", () => {
		process.env.ACB_UPLOADS_DIR = "/some/uploads";
		expect(resolveOutputDir()).toBe("/some/uploads");
	});
	it("falls back to <cwd>/uploads", () => {
		delete process.env.ACB_UPLOADS_DIR;
		expect(resolveOutputDir()).toBe(join(process.cwd(), "uploads"));
	});
});

describe("source tagging", () => {
	it("classifies a known id into its backend", () => {
		expect(imageModelSourceFor("flux-2-klein-int8")).toBe("local");
		expect(imageModelSourceFor("z-image-turbo")).toBe("local"); // local wins over venice
		expect(imageModelSourceFor("flux-2-max")).toBe("venice");
		expect(imageModelSourceFor("google/gemini-3-pro-image")).toBe("openrouter");
		expect(imageModelSourceFor("gpt-image-2")).toBe("openai-codex"); // codex catalog has it
		expect(imageModelSourceFor("some-unknown-model")).toBe("venice"); // legacy default
	});
	it("tags a bare id using the classifier", () => {
		expect(tagImageModelId("flux-2-klein-int8", imageModelSourceFor)).toBe(
			"local/flux-2-klein-int8",
		);
		expect(tagImageModelId("flux-2-max", imageModelSourceFor)).toBe("venice/flux-2-max");
		// OpenRouter ids keep their vendor slash after the source tag.
		expect(tagImageModelId("google/gemini-3-pro-image", imageModelSourceFor)).toBe(
			"openrouter/google/gemini-3-pro-image",
		);
	});
	it("is idempotent — already-tagged ids pass through", () => {
		expect(tagImageModelId("local/flux-2-klein-int8", imageModelSourceFor)).toBe(
			"local/flux-2-klein-int8",
		);
	});
	it("untags by splitting on the FIRST slash", () => {
		expect(untagImageModelId("local/flux-2-klein-int8")).toBe("flux-2-klein-int8");
		expect(untagImageModelId("openrouter/google/gemini-3-pro-image")).toBe(
			"google/gemini-3-pro-image",
		);
		expect(untagImageModelId("bare-id")).toBe("bare-id");
	});
	it("derives the source prefix", () => {
		expect(imageModelSource("local/x")).toBe("local");
		expect(imageModelSource("openrouter/google/x")).toBe("openrouter");
		expect(imageModelSource("bare")).toBe("venice"); // legacy default
	});
});

describe("resolveModel (parameterized)", () => {
	const opts = {
		ownSource: "venice" as const,
		envVar: "VENICE_IMAGE_MODEL",
		defaultModel: "z-image-turbo",
	};
	it("honours an explicit param above everything", () => {
		expect(resolveModel({ ...opts, explicit: "explicit-id" })).toBe("explicit-id");
	});
	it("strips the own-source tag from the override file", async () => {
		const file = join(tmpHome, ".config", "acb", "image-model");
		await mkdir(join(tmpHome, ".config", "acb"), { recursive: true });
		await writeFile(file, "venice/flux-2-max\n");
		expect(resolveModel(opts)).toBe("flux-2-max");
	});
	it("falls through on another backend's tag", async () => {
		const file = join(tmpHome, ".config", "acb", "image-model");
		await mkdir(join(tmpHome, ".config", "acb"), { recursive: true });
		await writeFile(file, "local/flux-2-klein-int8\n");
		expect(resolveModel(opts)).toBe("z-image-turbo"); // default, not the local id
	});
	it("passes a bare legacy id through unchanged", async () => {
		const file = join(tmpHome, ".config", "acb", "image-model");
		await mkdir(join(tmpHome, ".config", "acb"), { recursive: true });
		await writeFile(file, "some-bare-id\n");
		expect(resolveModel(opts)).toBe("some-bare-id");
	});
	it("falls back to env then default", () => {
		process.env.VENICE_IMAGE_MODEL = "env-model";
		expect(resolveModel(opts)).toBe("env-model");
		delete process.env.VENICE_IMAGE_MODEL;
		expect(resolveModel(opts)).toBe("z-image-turbo");
	});
});

describe("format helpers", () => {
	it("formatCost", () => {
		expect(formatCost(undefined)).toBe("");
		expect(formatCost(0)).toBe("free");
		expect(formatCost(0.03413875)).toBe("$0.0341");
	});
	it("extFromMediaType", () => {
		expect(extFromMediaType("image/png")).toBe("png");
		expect(extFromMediaType("image/jpeg")).toBe("jpg");
		expect(extFromMediaType("image/webp")).toBe("webp");
		expect(extFromMediaType("image/svg+xml")).toBe("svg");
		expect(extFromMediaType(undefined)).toBeNull();
		expect(extFromMediaType("image/avif")).toBeNull();
	});
	it("extFromOutputFormat", () => {
		expect(extFromOutputFormat("png", "jpg")).toBe("png");
		expect(extFromOutputFormat("jpeg", "png")).toBe("jpg");
		expect(extFromOutputFormat("weird", "png")).toBe("png");
	});
});
