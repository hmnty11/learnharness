import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import { promisify } from "node:util";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-pdf-converter-"));
const authFile = path.join(root, "auth.json");
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = authFile;
fs.writeFileSync(authFile, "{}");
const credentials = ["BAIDU_OCR_ACCESS_TOKEN", "BAIDU_OCR_API_KEY", "BAIDU_OCR_SECRET_KEY"];
const originalCredentials = credentials.map((key) => process.env[key]);
for (const key of credentials) delete process.env[key];

let markdown = "# External document\n\nFull external text.";
let ocrText = "";
const convertedInputs: Uint8Array[] = [];
let ocrCalls = 0;
// `promisify.custom` is non-configurable on the real execFile, so install a
// replacement export carrying the stubbed promisified implementation. The
// converter modules read that export when they are imported below.
const originalExecFile = childProcess.execFile;
const stub = function execFile() { throw new Error("callback execFile path is not used"); };
Object.defineProperty(stub, promisify.custom, {
	configurable: true,
	value: async (file: string, args: string[]) => {
		if (file === "markitdown" || file === "markitdown.cmd") {
			convertedInputs.push(new Uint8Array(fs.readFileSync(args[0]!)));
			return { stdout: markdown, stderr: "" };
		}
		if (file === "paddleocr" || file === "paddleocr.exe") {
			ocrCalls++;
			const png = fs.readFileSync(args[1]!);
			assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
			return { stdout: ocrText, stderr: "" };
		}
		throw new Error(`Unexpected executable: ${file}`);
	},
});
Object.defineProperty(childProcess, "execFile", { configurable: true, writable: true, value: stub });
syncBuiltinESMExports();

after(() => {
	Object.defineProperty(childProcess, "execFile", { configurable: true, writable: true, value: originalExecFile });
	syncBuiltinESMExports();
	for (const [i, key] of credentials.entries()) {
		const original = originalCredentials[i];
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

// Dynamic on purpose: the env roots and the stubbed execFile must be in place
// before these modules (and their converter imports) evaluate.
const { POST } = await import("../app/api/graph/import/route.ts");
const { extraction, sourceDirectory, writeSettingsRecord } = await import("../src/server/index.ts");
const originalImport = extraction.importNotes;
const originalRegister = sourceDirectory.registerImport;
const received: string[] = [];
const registered: string[] = [];
extraction.importNotes = async ({ text }) => { received.push(text); return { nodes: 0, chains: 0 }; };
sourceDirectory.registerImport = (filePath) => { registered.push(filePath); };
after(() => { extraction.importNotes = originalImport; sourceDirectory.registerImport = originalRegister; });
beforeEach(() => {
	convertedInputs.length = 0;
	received.length = 0;
	registered.length = 0;
	ocrCalls = 0;
	ocrText = "";
	markdown = "# External document\n\nFull external text.";
	writeSettingsRecord({ version: 1, graph: { ocrBaiduEnabled: false } });
});

async function upload(bytes: Uint8Array<ArrayBuffer> | string) {
	const form = new FormData();
	form.append("files", new File([bytes], "document.pdf"));
	const response = await POST(new Request("http://localhost/api/graph/import", { method: "POST", body: form }));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.equal(results.length, 1);
	return results[0];
}

function toc() {
	return {
		runs: ["Table of Contents", "Chapter 1: Intro ...... 1", "Chapter 2: Core ....... 15", "Chapter 3: Advanced ... 40"]
			.map((text, i) => ({ text, x: 72, y: 700 - i * 30, size: i === 0 ? 20 : 10 })),
	};
}

it("a successful full-document converter remains available after PDF preflight", async () => {
	const pdf = tinyPdf([{ runs: [{ text: "Built-in text", x: 72, y: 600 }] }]);
	const result = await upload(pdf);
	assert.equal(result.ok, true);
	assert.equal(result.notice, "Converted with Microsoft MarkItDown.");
	assert.deepEqual(received, ["# External document\n\nFull external text."]);
	assert.deepEqual(convertedInputs, [pdf], "external converter receives the original bytes, not a detached buffer");
});

it("a successful external converter cannot bypass the page cap or unreadable refusal", async () => {
	for (const [bytes, error] of [
		[tinyPdf(Array.from({ length: 1001 }, () => ({}))), "Too long. Max 1,000 pages."],
		["%PDF-1.4\nnot really a pdf", "Could not open this PDF."],
	] as const) {
		const result = await upload(bytes);
		assert.equal(result.ok, false);
		assert.equal(result.error, error);
	}
	assert.deepEqual(convertedInputs, []);
	assert.deepEqual(received, []);
	assert.deepEqual(registered, []);
});

it("external full-document text cannot reintroduce filtered navigation pages", async () => {
	const result = await upload(tinyPdf([toc(), { runs: [{ text: "Plants make sugar.", x: 72, y: 600 }] }]));
	assert.equal(result.ok, true);
	assert.equal(result.notice, "Scanned pages may have errors. Skipped 1 contents page.");
	assert.deepEqual(received, ["--- Page 2 ---\n\nPlants make sugar."]);
	assert.deepEqual(convertedInputs, []);
});

it("all-navigation refusal cannot be overridden by successful external text", async () => {
	const result = await upload(tinyPdf([toc()]));
	assert.equal(result.ok, false);
	assert.equal(result.error, "No content remains after skipping contents/index pages.");
	assert.deepEqual(convertedInputs, []);
	assert.deepEqual(received, []);
	assert.deepEqual(registered, []);
});

it("whitespace-only external output retains the built-in fallback", async () => {
	markdown = " \n\t ";
	const result = await upload(tinyPdf([{ runs: [{ text: "Built-in text", x: 72, y: 600 }] }]));
	assert.equal(result.ok, true);
	assert.equal(result.notice, "Scanned pages may have errors.");
	assert.deepEqual(received, ["--- Page 1 ---\n\nBuilt-in text"]);
	assert.equal(convertedInputs.length, 1);
});

it("image-only PDFs retain successful external conversion and existing empty-output refusal", async () => {
	assert.equal((await upload(tinyPdf([{ image: true }]))).ok, true);
	assert.deepEqual(received, ["# External document\n\nFull external text."]);
	markdown = " \n ";
	const result = await upload(tinyPdf([{ image: true }]));
	assert.equal(result.ok, false);
	assert.equal(result.error, "OCR not supported yet.");
	assert.equal(received.length, 1);
	assert.equal(convertedInputs.length, 2);
});

it("successful opt-in OCR is preserved instead of replaced by external text", async () => {
	writeSettingsRecord({ version: 1, graph: { ocrBaiduEnabled: true } });
	ocrText = "Recognized scan text.";
	const result = await upload(tinyPdf([{ image: true }]));
	assert.equal(result.ok, true);
	assert.equal(result.notice, "Scanned pages may have errors. Processed with Baidu OCR.");
	assert.deepEqual(received, ["--- Page 1 ---\n\nRecognized scan text."]);
	assert.equal(ocrCalls, 1);
	assert.deepEqual(convertedInputs, []);
});

it("an OCR attempt with no recognized pages can still use external conversion", async () => {
	writeSettingsRecord({ version: 1, graph: { ocrBaiduEnabled: true } });
	const pdf = tinyPdf([{ image: true }]);
	const result = await upload(pdf);
	assert.equal(result.ok, true);
	assert.equal(result.notice, "Converted with Microsoft MarkItDown.");
	assert.equal(ocrCalls, 1);
	assert.deepEqual(convertedInputs, [pdf]);
	assert.deepEqual(received, ["# External document\n\nFull external text."]);
});

it("navigation recognized by OCR is classified before any external fallback", async () => {
	writeSettingsRecord({ version: 1, graph: { ocrBaiduEnabled: true } });
	ocrText = "Table of Contents\nChapter 1: Intro ...... 1\nChapter 2: Core ....... 15\nChapter 3: Advanced ... 40";
	const result = await upload(tinyPdf([{ image: true }]));
	assert.equal(result.ok, false);
	assert.equal(result.error, "No content remains after skipping contents/index pages.");
	assert.equal(ocrCalls, 1);
	assert.deepEqual(convertedInputs, []);
	assert.deepEqual(received, []);
	assert.deepEqual(registered, []);
});
