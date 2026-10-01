import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-latex-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");
const { isLatex, loadLatex, bibliographies, renderLatexPage } = await import("../src/latex.js");

const hasPandoc = spawnSync(process.env.HUMAN_REVIEW_PANDOC || "pandoc", ["--version"], { windowsHide: true }).status === 0;
const needsPandoc = { skip: hasPandoc ? false : "pandoc is not installed" };

function request(port, token, { method = "GET", route = "/", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          "x-human-review-token": token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** A small paper: an \input'd section, a bibliography, math, and a user macro. */
function writePaper(dir) {
  fs.mkdirSync(path.join(dir, "sections"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "main.tex"),
    [
      "\\documentclass{article}",
      "\\newcommand{\\new}[1]{\\textbf{#1}}",
      "\\title{Home-Cage Notes}",
      "\\author{A. Author}",
      "\\begin{document}",
      "\\maketitle",
      "\\begin{abstract}",
      "We describe a \\new{small} ontology.",
      "\\end{abstract}",
      "\\section{Introduction}",
      "Cages are monitored~\\cite{smith2020}. The ratio is $a^2 + b^2 = c^2$.",
      "\\input{sections/methods}",
      "% \\input{sections/hidden}",
      "\\bibliographystyle{plain}",
      "\\bibliography{refs}",
      "\\end{document}",
      "",
    ].join("\n")
  );
  fs.writeFileSync(path.join(dir, "sections", "methods.tex"), "\\section{Methods}\nSensors record every second.\n");
  fs.writeFileSync(path.join(dir, "sections", "hidden.tex"), "\\section{Hidden}\nShould never appear.\n");
  fs.writeFileSync(path.join(dir, "refs.bib"), "@article{smith2020,\n  author = {Smith, Jane},\n  title = {Watching Mice},\n  journal = {Journal of Cages},\n  year = {2020}\n}\n");
  return path.join(dir, "main.tex");
}

test("isLatex matches only .tex files", () => {
  assert.equal(isLatex("/a/main.tex"), true);
  assert.equal(isLatex("/a/MAIN.TEX"), true);
  assert.equal(isLatex("/a/main.tex.html"), false);
  assert.equal(isLatex("/a/main.bib"), false);
});

test("loadLatex splices \\input files, skips comments, and lists every source", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "load-"));
  const main = writePaper(dir);
  const { text, files } = loadLatex(main);
  assert.match(text, /Sensors record every second/, "the \\input file is inlined");
  assert.doesNotMatch(text, /Should never appear/, "a commented-out \\input is not followed");
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.endsWith("methods.tex")));
});

test("loadLatex survives include cycles and refuses files outside the document folder", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "guard-"));
  const outside = path.join(tmp, "outside-secret.tex");
  fs.writeFileSync(outside, "TOP SECRET\n");
  fs.writeFileSync(path.join(dir, "a.tex"), "A\n\\input{b}\n\\input{../outside-secret}\n\\input{" + outside.replace(/\\/g, "/") + "}\n");
  fs.writeFileSync(path.join(dir, "b.tex"), "B\n\\input{a}\n");
  const { text } = loadLatex(path.join(dir, "a.tex"));
  assert.match(text, /^A\nB\n/);
  assert.doesNotMatch(text, /TOP SECRET/);
});

test("bibliographies finds declared .bib files that exist", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "bib-"));
  const main = writePaper(dir);
  const { text } = loadLatex(main);
  assert.deepEqual(
    bibliographies(text, main).map((f) => path.basename(f)),
    ["refs.bib"]
  );
  assert.deepEqual(bibliographies("\\bibliography{missing}\n% \\bibliography{refs}\n", main), []);
});

test("renderLatexPage renders title, abstract, sections, math, macros, and citations", needsPandoc, async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "render-"));
  const html = await renderLatexPage(writePaper(dir));
  const document = new JSDOM(html).window.document;
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.equal(document.querySelector("title").textContent, "main.tex");
  assert.equal(document.querySelector("h1.title").textContent, "Home-Cage Notes");
  assert.match(document.querySelector(".abstract").textContent, /small ontology/);
  assert.equal(document.querySelector(".abstract strong").textContent, "small", "a user macro is expanded");
  assert.deepEqual(
    [...document.querySelectorAll("h2")].map((h) => h.textContent.trim()).filter((t) => t !== "Abstract"),
    ["Introduction", "Methods"]
  );
  assert.match(document.body.textContent, /Sensors record every second/, "included sections render in place");
  assert.ok(document.querySelector("math"), "math renders as MathML, with nothing fetched");
  assert.doesNotMatch(html, /mathjax|https?:\/\/cdn/i);
  assert.match(document.body.textContent, /Watching Mice/, "citations resolve against the .bib file");
  assert.ok(document.querySelector("style"), "the shared review stylesheet is applied");
});

test("rendered LaTeX is inert: unsafe links, images, and raw HTML never become active", needsPandoc, async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "inert-"));
  const file = path.join(dir, "evil.tex");
  fs.writeFileSync(
    file,
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\href{javascript:alert(1)}{Bad link} \\href{https://example.com}{Good link}",
      "\\includegraphics{data:text/html,bad}",
      "\\begin{html}<script>alert(2)</script><img src=x onerror=alert(3)>\\end{html}",
      "\\end{document}",
      "",
    ].join("\n")
  );
  const html = await renderLatexPage(file);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll("script, iframe, svg, object, embed").length, 0);
  assert.equal(
    [...document.querySelectorAll("*")].some((el) => [...el.attributes].some((attr) => /^on/i.test(attr.name))),
    false
  );
  assert.equal(document.querySelectorAll('[href^="javascript:"], [src^="data:text/html"]').length, 0);
  assert.match(document.body.textContent, /Bad link/, "an unsafe link keeps its readable label");
  assert.deepEqual(
    [...document.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    ["https://example.com"]
  );
});

test("a missing pandoc is a clear, actionable error", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "nopandoc-"));
  const main = writePaper(dir);
  const saved = process.env.HUMAN_REVIEW_PANDOC;
  process.env.HUMAN_REVIEW_PANDOC = path.join(dir, "no-such-pandoc");
  try {
    await assert.rejects(() => renderLatexPage(main), /pandoc is required.*pandoc\.org/);
  } finally {
    if (saved === undefined) delete process.env.HUMAN_REVIEW_PANDOC;
    else process.env.HUMAN_REVIEW_PANDOC = saved;
  }
});

test("a latex review is rendered, flagged, feedback-only, and ships in the batch", needsPandoc, async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());

  const dir = fs.mkdtempSync(path.join(tmp, "review-"));
  const file = writePaper(dir);
  const source = fs.readFileSync(file, "utf8");

  const opened = await request(port, token, { method: "POST", route: "/api/session", body: { file } });
  assert.equal(opened.status, 200);
  const { key, sessionId, artifactToken } = JSON.parse(opened.raw);

  await t.test("the artifact route serves rendered html with the sdk injected", async () => {
    const res = await request(port, token, { route: `/artifact/${artifactToken}/${key}/index.html` });
    assert.equal(res.status, 200);
    assert.match(res.raw, /<h2[^>]*>Introduction<\/h2>/);
    assert.match(res.raw, /Sensors record every second/);
    assert.match(res.raw, /data-eh-sdk/);
    assert.doesNotMatch(res.raw, /\\section/, "raw LaTeX does not leak through");
  });

  await t.test("page state marks the page as latex", async () => {
    const res = await request(port, token, { route: `/api/page/${key}` });
    const page = JSON.parse(res.raw);
    assert.equal(page.latex, true);
    assert.equal(page.markdown, false);
  });

  await t.test("saves are refused so the source file survives", async () => {
    const res = await request(port, token, {
      method: "POST",
      route: `/api/page/${key}/save`,
      body: { html: "<!DOCTYPE html><html><body>overwritten</body></html>" },
    });
    assert.equal(res.status, 400);
    assert.equal(fs.readFileSync(file, "utf8"), source);
  });

  await t.test("comments ship in the batch with the tex path and LaTeX guidance", async () => {
    await request(port, token, {
      method: "POST",
      route: `/api/page/${key}/comment`,
      body: { kind: "selection", quote: "Sensors record every second.", feedback: "Say which sensors." },
    });
    const sent = await request(port, token, {
      method: "POST",
      route: `/api/page/${key}/send`,
      body: { sessionId, note: "" },
    });
    assert.equal(sent.status, 200);
    const polled = await request(port, token, { route: `/api/poll?file=${encodeURIComponent(file)}` });
    const batch = JSON.parse(polled.raw);
    assert.equal(batch.status, "feedback");
    const page = batch.pages.find((p) => p.file === fs.realpathSync(file));
    assert.equal(page.latex, true);
    assert.equal(page.edits_saved, false);
    assert.equal(page.comments[0].feedback, "Say which sensors.");
    assert.match(batch.next_step, /`\.tex` source/);
    assert.match(batch.next_step, /\\input/);
  });
});

test("a render failure is reported on the page instead of a blank frame", needsPandoc, async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());
  const dir = fs.mkdtempSync(path.join(tmp, "fail-"));
  const file = writePaper(dir);
  const saved = process.env.HUMAN_REVIEW_PANDOC;
  process.env.HUMAN_REVIEW_PANDOC = path.join(dir, "no-such-pandoc");
  t.after(() => {
    if (saved === undefined) delete process.env.HUMAN_REVIEW_PANDOC;
    else process.env.HUMAN_REVIEW_PANDOC = saved;
  });
  const opened = await request(port, token, { method: "POST", route: "/api/session", body: { file } });
  const { key, artifactToken } = JSON.parse(opened.raw);
  const res = await request(port, token, { route: `/artifact/${artifactToken}/${key}/index.html` });
  assert.equal(res.status, 502);
  assert.match(res.raw, /Could not render main\.tex: pandoc is required/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
