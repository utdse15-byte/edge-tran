// Tests that the CLI entry points actually start when run as scripts.
//
// These exist because of a bug that no other suite could have caught. Both
// servers detect "am I being run directly?" so they can double as libraries
// (imported by tests) and as commands (`npm run gemini:live`). The original
// guard compared `import.meta.url` against a hand-built `file://${argv[1]}`.
// On POSIX that happens to match. On Windows `process.argv[1]` is
// `G:\dir\file.mjs` while `import.meta.url` is `file:///G:/dir/file.mjs`, so
// the comparison was never true, the CLI block never ran, and the process
// exited silently with zero output and status 0 — the user saw their shell
// prompt come straight back and the extension reported `network_error`.
//
// Every unit and e2e suite imports these modules as libraries, which is the
// one path the bug did not affect. So the regression has to be what a user
// does: spawn the file and see whether a server comes up.

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Spawn a server script, wait for it to listen, hand the port to `body`, then
// make sure it dies. Rejects with the child's output if it exits early, which
// is exactly the failure being guarded against.
async function withSpawnedServer({ script, args = [], env = {} }, body) {
  const child = spawn(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    const ready = await Promise.race([
      (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (/listening on http:\/\/\S+/.test(output)) return { listening: true };
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { listening: false };
      })(),
      exited.then((status) => ({ listening: false, ...status }))
    ]);

    assert.ok(
      ready.listening,
      `${script} did not start as a CLI (exit=${ready.code} signal=${ready.signal}); output was ${JSON.stringify(output)}`
    );

    await body({ output, child });
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}

function portFrom(output) {
  const match = output.match(/listening on (http:\/\/\S+)/);
  assert.ok(match, `no listen line in ${JSON.stringify(output)}`);
  return match[1];
}

test("the Live bridge starts when run as a command", async () => {
  await withSpawnedServer(
    { script: "scripts/gemini-live-bridge.mjs", args: ["--port", "0"], env: { GEMINI_API_KEY: "test-key-not-used" } },
    async ({ output }) => {
      const origin = portFrom(output);
      // /v1/models is answered by the bridge itself and never reaches Google,
      // so this proves the socket is live without spending any token budget.
      const response = await fetch(`${origin}/v1/models`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.object, "list");
      assert.ok(payload.data.length > 0);
      // The banner is the user's copy/paste source; if it stops naming the
      // Base URL the setup instructions in README/CHANGELOG go stale.
      assert.match(output, /Base URL\s*:\s*http:\/\/\S+\/v1/);
      assert.match(output, /Model\s*:\s*\S+/);
    }
  );
});

test("the Live bridge refuses to start without a key, loudly", async () => {
  const child = spawn(process.execPath, [path.join(root, "scripts/gemini-live-bridge.mjs")], {
    cwd: root,
    env: { ...process.env, GEMINI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const status = await new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  // A silent exit(0) is indistinguishable from the Windows bug it is being
  // told apart from, so a missing key must be a non-zero exit *and* a message.
  assert.notEqual(status, 0, "a missing API key must not exit successfully");
  assert.match(output, /GEMINI_API_KEY/);
});

test("the mock provider starts when run as a command", async () => {
  await withSpawnedServer(
    { script: "scripts/mock-provider.mjs", args: ["--port", "0"] },
    async ({ output }) => {
      const origin = portFrom(output);
      const response = await fetch(`${origin}/ok/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "hello" }] })
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(payload.choices?.[0]?.message?.content, "the mock gateway answered without content");
    }
  );
});

// The guard has to survive being imported with no argv[1] at all, which is what
// `node -e` and embedders do. `pathToFileURL(undefined)` throws a TypeError, so
// an unguarded call turns every such import into a hard failure.
test("both entry points import cleanly with no argv[1]", async () => {
  for (const script of ["scripts/gemini-live-bridge.mjs", "scripts/mock-provider.mjs"]) {
    const url = pathToFileURL(path.join(root, script)).href;
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["-e", `import(${JSON.stringify(url)}).then(() => console.log("OK")).catch((error) => { console.error(error.message); process.exit(1); })`],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
      );
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("exit", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, `${script} failed to import without argv[1]: ${result.output}`);
    assert.match(result.output, /OK/);
    // Importing must not start a server as a side effect.
    assert.doesNotMatch(result.output, /listening on/);
  }
});

// The spawn tests above pass on POSIX whether or not the bug is present,
// because `file://${argv[1]}` happens to be correct when paths use forward
// slashes and need no escaping. Only a Windows-shaped path tells the two
// candidate comparisons apart, so assert on that shape directly — this is the
// check that fails if anyone reverts to string concatenation.
test("the direct-invocation guard is built the only way that works on Windows", async () => {
  // `pathToFileURL` is bound to the host platform, so a win32 path cannot be
  // normalised from this test run. What is testable everywhere is the property
  // the guard actually needs: pathToFileURL round-trips whatever this platform
  // puts in argv[1] back onto the import.meta.url form. That is true on Windows
  // too, and it is precisely what concatenation fails to do there.
  assert.equal(
    pathToFileURL(fileURLToPath(import.meta.url)).href,
    import.meta.url,
    "pathToFileURL must round-trip a host path onto the import.meta.url form"
  );

  // The concatenation half is a plain string fact, so it holds on any host:
  // this is the exact pair the user's machine compared, and it never matched.
  const windowsArgv = "G:\\edge-tran-main\\scripts\\gemini-live-bridge.mjs";
  const windowsModuleUrl = "file:///G:/edge-tran-main/scripts/gemini-live-bridge.mjs";
  assert.notEqual(
    `file://${windowsArgv}`,
    windowsModuleUrl,
    "string concatenation must not be mistaken for a working guard"
  );

  // And the shipped sources must use that primitive rather than re-deriving it.
  for (const script of ["scripts/gemini-live-bridge.mjs", "scripts/mock-provider.mjs"]) {
    const text = await readFile(path.join(root, script), "utf8");
    assert.match(
      text,
      /import \{[^}]*pathToFileURL[^}]*\} from "node:url"/,
      `${script} must import pathToFileURL`
    );
    assert.match(
      text,
      /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/,
      `${script} must compare import.meta.url against pathToFileURL(argv[1])`
    );
    assert.doesNotMatch(
      text,
      /`file:\/\/\$\{\s*process\.argv\[1\]\s*\}`/,
      `${script} must not rebuild a file URL by concatenation`
    );
  }
});

// Control bytes in source are invisible in an editor but make git and grep
// treat the file as binary, which is how a stray NUL sat undetected inside a
// template literal in the bridge. Text sources must stay text.
test("no source file carries stray control bytes", async () => {
  const files = [
    "scripts/gemini-live-bridge.mjs",
    "scripts/mock-provider.mjs",
    "scripts/audit.mjs",
    "scripts/check-syntax.js",
    "panel.js",
    "writer.js",
    "sw.js",
    "lib/provider.js",
    "lib/translator.js",
    "lib/shared.js",
    "lib/validation.js"
  ];
  for (const file of files) {
    const text = await readFile(path.join(root, file), "utf8");
    // Tab, LF and CR are the only control characters a source file may hold.
    const match = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    assert.equal(
      match,
      null,
      match
        ? `${file} contains control byte U+${match[0].charCodeAt(0).toString(16).padStart(4, "0")} at offset ${match.index}`
        : ""
    );
  }
});
