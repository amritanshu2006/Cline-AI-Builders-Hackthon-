import fs from 'node:fs';
import path from 'node:path';

// Extracted from mockAgent.js dynamically.
function matchType(id) {
  if (id.includes("path")) return "path";
  if (id.includes("cmd") || id.includes("command")) return "cmd";
  if (id.includes("proto")) return "proto";
  if (id.includes("jwt") || id.includes("secret") || id.includes("hardcoded")) return "jwt";
  return null;
}

const EXPLOIT_PATH_TRAVERSAL = `const request = require("supertest");
const app = require("../server");
describe("exploit: Path Traversal (CWE-22)", () => {
  test("should NOT serve files outside public dir", async () => {
    const res = await request(app).get("/files?name=../package.json");
    expect([400, 403, 404]).toContain(res.status);
    if (res.status === 200) expect(res.text).not.toContain("sample-vulnerable-app");
  });
});`;

const EXPLOIT_COMMAND_INJECTION = `const request = require("supertest");
const app = require("../server");
describe("exploit: Command Injection (CWE-78)", () => {
  test("should NOT execute injected shell commands", async () => {
    const res = await request(app).get("/ping?host=127.0.0.1%26%26echo+INJECTED");
    const output = JSON.stringify(res.body || "");
    expect(output).not.toContain("INJECTED");
  });
});`;

const EXPLOIT_PROTOTYPE_POLLUTION = `const request = require("supertest");
const app = require("../server");
describe("exploit: Prototype Pollution (CWE-1321)", () => {
  test("should NOT allow prototype pollution via __proto__ path", async () => {
    const res = await request(app)
      .post("/preferences")
      .send({ path: "__proto__.isAdmin", value: true });
    expect([200, 400]).toContain(res.status);
    const fresh = {};
    expect(fresh.isAdmin).toBeUndefined();
  });
});`;

const EXPLOIT_HARDCODED_SECRET = `const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../server");
describe("exploit: Hardcoded JWT Secret", () => {
  test("should NOT use the well-known demo secret", async () => {
    const res = await request(app).post("/login").send({ username: "attacker" });
    expect(res.status).toBe(200);
    const knownSecret = "patchproof-demo-secret";
    let verifies = true;
    try { jwt.verify(res.body.token, knownSecret); } catch { verifies = false; }
    expect(verifies).toBe(false);
  });
});`;

function getExploitTest(type) {
  if (type === "path") return EXPLOIT_PATH_TRAVERSAL;
  if (type === "cmd") return EXPLOIT_COMMAND_INJECTION;
  if (type === "proto") return EXPLOIT_PROTOTYPE_POLLUTION;
  if (type === "jwt") return EXPLOIT_HARDCODED_SECRET;
  return null;
}

// Block-aware replacement logic from teammate's mockAgent.js
function findHandlerBlock(code, startMarker) {
  const start = code.indexOf(startMarker);
  if (start === -1) return null;
  const open = code.indexOf("{", start);
  if (open === -1) return null;
  let depth = 1;
  let i = open + 1;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch; i++;
      while (i < code.length && code[i] !== quote) { if (code[i] === "\\") i++; i++; }
    }
    i++;
  }
  if (depth !== 0) return null;
  return { start, open, close: i };
}

function replaceHandler(code, startMarker, replacement) {
  const block = findHandlerBlock(code, startMarker);
  if (!block) return code;
  let end = code.indexOf(");", block.close);
  if (end === -1) return code;
  end += 2;
  return code.slice(0, block.start) + replacement + code.slice(end);
}

function applyFix(code, type) {
  if (type === "path") {
    return replaceHandler(
      code,
      'app.get("/files"',
      `app.get("/files", (req, res) => {
  const filename = req.query.name;
  const baseDir = path.resolve(__dirname, "public");
  const filePath = path.resolve(baseDir, filename);
  if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
    return res.status(403).json({ error: "access denied" });
  }
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) return res.status(404).json({ error: "not found" });
    res.send(data);
  });
});`
    );
  }
  if (type === "cmd") {
    return replaceHandler(
      code,
      'app.get("/ping"',
      `app.get("/ping", (req, res) => {
  const host = req.query.host || "127.0.0.1";
  if (!/^[a-zA-Z0-9.\\-:]+$/.test(host)) {
    return res.status(400).json({ error: "invalid host" });
  }
  const { execFile } = require("child_process");
  const pingFlag = process.platform === "win32" ? "-n" : "-c";
  execFile("ping", [pingFlag, "1", host], (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });
    res.json({ output: stdout });
  });
});`
    );
  }
  if (type === "proto") {
    return replaceHandler(
      code,
      'app.post("/preferences"',
      `app.post("/preferences", (req, res) => {
  const defaults = { theme: "light", notifications: true };
  const userPath = req.body.path || "theme";
  const userValue = req.body.value || "custom";
  if (typeof userPath !== "string" || userPath.includes("__proto__") || userPath.includes("constructor")) {
    return res.status(400).json({ error: "invalid path" });
  }
  if (userPath.indexOf(".") === -1 && userPath.indexOf("[") === -1) {
    defaults[userPath] = userValue;
  } else {
    return res.status(400).json({ error: "nested paths not allowed" });
  }
  res.json(defaults);
});`
    );
  }
  if (type === "jwt") {
    return code.replace(
      'const JWT_SECRET = "patchproof-demo-secret";',
      'const JWT_SECRET = process.env.JWT_SECRET || require("crypto").randomBytes(32).toString("hex");'
    );
  }
  return code;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const idFrom = (prompt, sessionId) =>
  sessionId || prompt.match(/patchproof_exploits\/([^\s`'"\\/]+?)\.test\.js/)?.[1];

export async function replayAgent(cwd, prompt, sessionId, say = () => {}) {
  const id = idFrom(prompt, sessionId);
  console.log("REPLAY_AGENT ID:", id);
  if (!id) throw new Error("replay: could not parse finding ID");
  const type = matchType(id);
  console.log("REPLAY_AGENT TYPE:", type);
  if (!type) throw new Error("replay: unknown vulnerability type for id " + id);
  
  await pause(Number(process.env.PP_REPLAY_DELAY_MS ?? 1500));

  if (prompt.startsWith('Security finding to reproduce')) {
    const rel = `patchproof_exploits/${id}.test.js`;
    say(`[mockAgent] writing exploit test ${rel}`);
    fs.mkdirSync(path.join(cwd, 'patchproof_exploits'), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), getExploitTest(type));
    return id;
  }

  // Any other prompt = fix.
  const target = path.join(cwd, 'server.js');
  let src = fs.readFileSync(target, 'utf8');
  src = applyFix(src, type);
  fs.writeFileSync(target, src);
  say(`[mockAgent] patched server.js for ${type}`);
  return id;
}

export function replayExplain(finding) {
  return `Fixed: ${finding.title} using MockAgent patterns.`;
}
