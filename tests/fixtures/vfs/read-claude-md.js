// Fixture used by tests/vfs.test.ts to exercise agents-md-vfs.js.
//
// Run either directly with `bun` (gate stays OFF — normal fs behavior) or as
// a `bun build --compile` binary whose path contains "claude" (gate turns ON
// when combined with BUN_OPTIONS="--require .../agents-md-vfs.js"), then
// pointed at a directory containing CLAUDE.md and/or AGENTS.md.
//
// Prints a single JSON line to stdout describing what every patched fs entry
// point observed for <dir>/CLAUDE.md.
"use strict";

const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
const claudeMdPath = path.join(dir, "CLAUDE.md");

async function main() {
  const out = { argv1: process.argv[1], execPath: process.execPath };

  out.existsSync = fs.existsSync(claudeMdPath);

  try {
    const asUtf8 = fs.readFileSync(claudeMdPath, "utf8");
    out.readFileSyncUtf8 = asUtf8;
    out.readFileSyncUtf8IsString = typeof asUtf8 === "string";
  } catch (e) {
    out.readFileSyncUtf8Error = e.code;
  }

  try {
    const asBuffer = fs.readFileSync(claudeMdPath);
    out.readFileSyncBufferIsBuffer = Buffer.isBuffer(asBuffer);
    out.readFileSyncBufferContent = asBuffer.toString("utf8");
  } catch (e) {
    out.readFileSyncBufferError = e.code;
  }

  out.readFileCallback = await new Promise((resolve) => {
    fs.readFile(claudeMdPath, "utf8", (err, data) => {
      resolve(err ? { error: err.code } : data);
    });
  });

  out.statCallback = await new Promise((resolve) => {
    fs.stat(claudeMdPath, (err) => resolve(err ? { error: err.code } : "ok"));
  });

  out.statCallbackSize = await new Promise((resolve) => {
    fs.stat(claudeMdPath, (err, st) => resolve(err ? { error: err.code } : st.size));
  });

  try {
    const st = fs.statSync(claudeMdPath);
    out.statSyncSize = st.size;
  } catch (e) {
    out.statSyncSizeError = e.code;
  }

  try {
    const pst = await fs.promises.stat(claudeMdPath);
    out.promisesStatSize = pst.size;
  } catch (e) {
    out.promisesStatSizeError = e.code;
  }

  try {
    out.promisesReadFile = await fs.promises.readFile(claudeMdPath, "utf8");
  } catch (e) {
    out.promisesReadFileError = e.code;
  }

  console.log(JSON.stringify(out));
}

main();
