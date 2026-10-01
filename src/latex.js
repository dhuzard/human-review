import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STYLE } from "./markdown.js";

export const isLatex = (file) => /\.tex$/i.test(file);

const here = path.dirname(fileURLToPath(import.meta.url));
const FILTER = path.join(here, "latex-filter.lua");
const TEMPLATE = path.join(here, "latex-template.html");

const MAX_DEPTH = 8;
const PANDOC_TIMEOUT_MS = 30000;
const PANDOC_MAX_BUFFER = 64 * 1024 * 1024;

/** Drop everything after an unescaped `%`, which LaTeX treats as a comment. */
const stripComments = (line) => line.replace(/(^|[^\\])%.*$/, "$1");

/**
 * `\input{sections/intro}` names `sections/intro.tex`; `.tex` is optional.
 * Only files inside the document's own folder are followed, so a document
 * cannot pull an arbitrary file on disk into the review page.
 */
function resolveInclude(dir, name) {
  const base = path.resolve(dir, name.trim());
  for (const candidate of [base, `${base}.tex`]) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const real = fs.realpathSync(candidate);
      const relative = path.relative(fs.realpathSync(dir), real);
      if (relative && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative)) return real;
    } catch {
      // Try the next spelling.
    }
  }
  return null;
}

/**
 * Read a document with its `\input` / `\include` files spliced in. Inlining
 * here, instead of letting pandoc follow the includes, lets pandoc run in its
 * sandbox: it never reads a path the document merely names. `files` lists
 * every source that went into the text, so the watcher can follow them all.
 */
export function loadLatex(file) {
  const files = [];
  const seen = new Set();
  const dir = path.dirname(file);

  function read(target, depth) {
    const real = fs.realpathSync(target);
    files.push(real);
    seen.add(real);
    const text = fs.readFileSync(real, "utf8");
    return text
      .split(/\r?\n/)
      .map((raw) => {
        const line = stripComments(raw);
        if (depth >= MAX_DEPTH) return line;
        return line.replace(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g, (whole, name) => {
          const child = resolveInclude(dir, name);
          if (!child) return whole;
          const childReal = fs.realpathSync(child);
          if (seen.has(childReal)) return whole;
          return read(childReal, depth + 1);
        });
      })
      .join("\n");
  }

  return { text: read(file, 0), files };
}

/** Bibliography files the document declares, as absolute paths that exist. */
export function bibliographies(text, file) {
  const found = [];
  const dir = path.dirname(file);
  const uncommented = text.split(/\r?\n/).map(stripComments).join("\n");
  for (const match of uncommented.matchAll(/\\bibliography\s*\{([^}]+)\}|\\addbibresource(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    for (const raw of (match[1] || match[2]).split(",")) {
      const name = raw.trim();
      if (!name) continue;
      const candidate = path.resolve(dir, /\.bib$/i.test(name) ? name : `${name}.bib`);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  return [...new Set(found)];
}

function runPandoc(args, input) {
  const bin = process.env.HUMAN_REVIEW_PANDOC || "pandoc";
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { encoding: "utf8", timeout: PANDOC_TIMEOUT_MS, maxBuffer: PANDOC_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && error.code === "ENOENT") {
          return reject(new Error("pandoc is required to review .tex files and was not found on PATH. Install it from https://pandoc.org/installing.html"));
        }
        if (error) {
          const detail = String(stderr || error.message).trim().split(/\r?\n/)[0];
          return reject(new Error(`pandoc could not render this document: ${detail}`));
        }
        resolve(stdout);
      }
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * Render a LaTeX file into a standalone review page. Like Markdown, the page
 * is a viewing surface only: it is never written back, and feedback refers to
 * the rendered text, so the agent applies it to the `.tex` source.
 *
 * Math becomes MathML, so nothing loads from the network. Figures drawn in
 * TikZ and other raw LaTeX are not rendered; their captions are.
 */
export async function renderLatexPage(file) {
  const { text } = loadLatex(file);
  const bibs = bibliographies(text, file);
  const args = [
    "--sandbox",
    "--from=latex",
    "--to=html5",
    "--standalone",
    `--template=${TEMPLATE}`,
    `--lua-filter=${FILTER}`,
    "--mathml",
    // The document title is the page's h1, so \section starts at h2.
    "--shift-heading-level-by=1",
    `--metadata=pagetitle:${path.basename(file)}`,
    ...(bibs.length ? ["--citeproc", ...bibs.map((bib) => `--bibliography=${bib}`)] : []),
  ];
  const html = await runPandoc(args, text);
  return html.replace("</head>", () => `<style>${STYLE}</style>\n</head>`);
}
