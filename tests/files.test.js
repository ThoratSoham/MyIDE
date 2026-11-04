/* PART 3 tests (a)(b)(c): the AI must really create files.
 * The real, compiled JobManager runs in plain Node against a fake provider, so
 * no test ever calls a real model. Files are checked on disk, not in memory. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const { REPO, installElectronStub, freshWorkspace, makeFakeAI, waitForIdle, okReply, textReply } =
  require(path.join(__dirname, "helpers", "harness.js"));

installElectronStub();
const { setWorkspaceRoot } = require(path.join(REPO, "dist", "main", "fs-workspace.js"));
const { JobManager } = require(path.join(REPO, "dist", "main", "jobs.js"));

/** A JobManager wired to a throw-away workspace and a scripted fake provider. */
function makeJobs(workspace, ai) {
  const events = [];
  const opened = [];
  const previewed = [];
  const root = path.resolve(workspace);
  setWorkspaceRoot(root);
  const jobs = new JobManager({
    ai,
    workspaceRoot: () => root,
    emit: (e) => events.push(e),
    onPreview: (rel) => previewed.push(rel),
    onOpenFile: (rel) => opened.push(rel),
    onWorkspaceChanged: () => undefined,
  });
  return { jobs, events, opened, previewed, root };
}

const sizeOf = (root, rel) => {
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? fs.statSync(abs).size : -1;
};

test("(a) a model that calls writeFile really creates the file on disk", async () => {
  const ws = freshWorkspace("files-a");
  const ai = makeFakeAI([
    () => okReply({ thought: "Creating the page.", tool: "writeFile", args: { path: "hello.html", content: "<!doctype html>\n<h1>Hello</h1>\n" } }),
    () => okReply({ thought: "Done.", answer: "Created hello.html." }),
  ]);
  const { jobs, events, opened, previewed, root } = makeJobs(ws, ai);

  jobs.start({ text: "create a hello page", mode: "fast", intent: "agent" });
  const snap = await waitForIdle(jobs);

  // The file is on disk and not empty.
  assert.ok(sizeOf(root, "hello.html") > 0, "hello.html must exist on disk with content");

  // It shows in the "Files changed" card and in the files event.
  const card = snap.messages.find((m) => m.role === "notice" && /^Files changed/.test(m.text));
  assert.ok(card, "a Files changed card must be in the chat");
  assert.equal(card.files.length, 1);
  assert.equal(card.files[0].path, "hello.html");
  assert.equal(card.files[0].change, "created");
  assert.ok(card.files[0].bytes > 0, "the card must report the real on-disk byte size");
  assert.ok(events.some((e) => e.type === "files"), "a files event must be emitted");

  // The tool hop is visible, and the html is auto-opened in the editor + preview.
  assert.ok(snap.messages.some((m) => m.role === "tool" && /writeFile/.test(m.text)), "the tool call must be visible");
  assert.deepEqual(opened, ["hello.html"]);
  assert.ok(previewed.includes("hello.html"), "the preview must be pointed at the new html");

  jobs.dispose();
});

test("(b) code-as-text nudges once, then offers Save these files", async () => {
  const ws = freshWorkspace("files-b");
  const answer = "Here is the page.\n\n```html index.html\n<h1>Hello</h1>\n```\n";
  const ai = makeFakeAI([() => okReply({ thought: "Here is the code.", answer })]);
  const { jobs, root } = makeJobs(ws, ai);

  jobs.start({ text: "build me a page about cats", mode: "fast", intent: "agent" });
  const snap = await waitForIdle(jobs);

  // Nothing was written, because the model never called a tool.
  assert.equal(sizeOf(root, "index.html"), -1, "no file must exist while the model only types code");

  // The nudge really happened: the next prompt told the model to use writeFile.
  assert.ok(ai.calls.length >= 2, "the model must be called again after the nudge");
  assert.match(String(ai.calls[1].last), /writeFile now/i, "the nudge must ask for writeFile");

  // Then the user is offered the parsed files.
  const offer = snap.messages.find((m) => m.action && m.action.kind === "save-files");
  assert.ok(offer, "a Save these files action must be offered");
  assert.match(offer.action.label, /^Save these 1 files$/);

  // One click saves them, and they land on disk.
  jobs.saveSuggested();
  assert.ok(sizeOf(root, "index.html") > 0, "Save these files must write index.html to disk");

  jobs.dispose();
});

test("(c) a garbage model still leaves the starter template on disk", async () => {
  const ws = freshWorkspace("files-c");
  const ai = makeFakeAI([() => textReply("this is not json at all, sorry")]);
  const { jobs, root } = makeJobs(ws, ai);

  jobs.start({ text: "build a website for a bakery", mode: "fast", intent: "website" });
  const snap = await waitForIdle(jobs, 30000);

  // PART 3 point 7: the starter is written through the real writeFile tool.
  assert.ok(sizeOf(root, "index.html") > 0, "index.html must exist even when the model fails");
  assert.ok(sizeOf(root, "css/style.css") > 0, "css/style.css must exist");
  assert.ok(sizeOf(root, "js/main.js") > 0, "js/main.js must exist");

  // The run must not claim a clean success without files.
  assert.ok(snap.files.length >= 3, "the run must report the files it changed");

  jobs.dispose();
});
