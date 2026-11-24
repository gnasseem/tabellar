// The text of an attachment, for a reply that has to know what is in it. Text
// kinds are decoded here; Word, PDF and slides are read by what macOS has
// (textutil, PDFKit, unzip), each in a process of its own with a time limit,
// since a file that arrived by email is not to be trusted. "" when it has no
// text or cannot be read.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeText, htmlToText } from "./mime.ts";

const LIMIT_MS = 10_000;
const MAX_OUT = 4 * 1024 * 1024;

const TEXT = /^(txt|text|md|markdown|csv|tsv|ics|log|json|xml|ya?ml)$/;
const TEXTUTIL = /^(docx?|rtf|odt)$/;
const ZIPPED = /^(xlsx|pptx)$/;

const kindOf = (name: string, mime: string): string => {
  const ext = name.toLowerCase().match(/\.([a-z0-9]{2,8})$/)?.[1] ?? "";
  if (TEXT.test(ext) || TEXTUTIL.test(ext) || ZIPPED.test(ext) || /^(html?|pdf)$/.test(ext)) return ext;
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html") return "html";
  return /^text\//.test(mime) ? "txt" : "";
};

// Whether a file has text to read, told from its name and type alone.
export const readable = (name: string, mime: string): boolean => !!kindOf(name, mime);

function run(command: string, args: string[], input?: Buffer): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: LIMIT_MS, maxBuffer: MAX_OUT, killSignal: "SIGKILL", encoding: "utf8" }, (e, out) => resolve(e ? "" : out));
    child.on("error", () => resolve(""));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

async function inFile<T>(bytes: Buffer, ext: string, work: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tabellar-file-"));
  try {
    const path = join(dir, `file.${ext}`);
    await writeFile(path, bytes, { mode: 0o600 });
    return await work(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PDF = `ObjC.import("PDFKit"); function run(argv) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); return d.isNil() || d.isLocked ? "" : ObjC.unwrap(d.string); }`;

const unxml = (s: string) => htmlToText(s.replace(/<[^>]+>/g, "")).trim();

// The rows of the first sheet, one per line, cells with commas between them.
async function sheet(path: string): Promise<string> {
  const shared = [...(await run("unzip", ["-p", path, "xl/sharedStrings.xml"])).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const rows = [...(await run("unzip", ["-p", path, "xl/worksheets/sheet1.xml"])).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
  return rows
    .slice(0, 400)
    .map(([, row]) =>
      [...row.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
        .map(([, at, cell]) => (/t="s"/.test(at) ? (shared[Number(cell.match(/<v>(\d+)<\/v>/)?.[1])] ?? "") : unxml(cell.match(/<(?:v|t)[^>]*>([\s\S]*?)<\/(?:v|t)>/)?.[1] ?? "")))
        .join(", "),
    )
    .join("\n");
}

async function slides(path: string): Promise<string> {
  const out: string[] = [];
  for (let i = 1; i <= 40; i++) {
    const xml = await run("unzip", ["-p", path, `ppt/slides/slide${i}.xml`]);
    if (!xml) break;
    out.push([...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((p) => unxml([...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join(""))).filter(Boolean).join("\n"));
  }
  return out.join("\n\n");
}

export async function fileText(name: string, mime: string, bytes: Buffer): Promise<string> {
  const kind = kindOf(name, mime);
  let text = "";
  if (TEXT.test(kind)) text = decodeText(bytes);
  else if (/^html?$/.test(kind)) text = htmlToText(decodeText(bytes));
  else if (TEXTUTIL.test(kind)) text = await run("/usr/bin/textutil", ["-noload", "-convert", "txt", "-encoding", "UTF-8", "-stdin", "-stdout", "-format", kind], bytes);
  else if (kind === "pdf") text = await inFile(bytes, kind, (path) => run("/usr/bin/osascript", ["-l", "JavaScript", "-e", PDF, path]));
  else if (kind === "xlsx") text = await inFile(bytes, kind, sheet);
  else if (kind === "pptx") text = await inFile(bytes, kind, slides);
  return text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
