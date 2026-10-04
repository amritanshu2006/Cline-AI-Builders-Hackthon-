"use strict";
const express = require("express");
const _ = require("lodash");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

const JWT_SECRET = "patchproof-demo-secret";

// --- VULNERABILITY #1: Path Traversal (CWE-22) ---
// Reads any file on disk because the user-supplied filename is concatenated
// into the path with no sanitisation and no containment check.
app.get("/files", (req, res) => {
  const filename = req.query.name;
  const filePath = path.join(__dirname, "public", filename);
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) return res.status(404).json({ error: "not found" });
    res.send(data);
  });
});

// --- VULNERABILITY #2: Command Injection (CWE-78) ---
// Passes user input directly to a shell, allowing arbitrary command execution
// via shell metacharacters (e.g. "; rm -rf /" or "$(whoami)").
app.get("/ping", (req, res) => {
  const host = req.query.host || "127.0.0.1";
  const pingFlag = process.platform === "win32" ? "-n" : "-c";
  exec(`ping ${pingFlag} 1 ${host}`, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });
    res.json({ output: stdout });
  });
});

// --- VULNERABILITY #3: Prototype Pollution via lodash.set (CWE-1321) ---
// lodash 4.17.15 _.set follows __proto__ paths, allowing prototype pollution
// A naive recursive setter that DOES follow __proto__ / constructor.prototype paths.
// lodash.set in v4.17.15 already silently blocks the basic __proto__ vector —
// we use a hand-rolled implementation here so the demo is reliably exploitable.
function unSafeSet(target, path, value) {
  const parts = path.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

app.post("/preferences", (req, res) => {
  const defaults = { theme: "light", notifications: true };
  const userPath = req.body.path || "theme";
  const userValue = req.body.value || "custom";
  // Vulnerable: user-controlled path traverses into __proto__ / constructor.prototype
  console.log("DEBUG userPath=" + JSON.stringify(userPath) + " userValue=" + JSON.stringify(userValue));
  unSafeSet(defaults, userPath, userValue);
  console.log("DEBUG defaults=", defaults, "isAdmin=", ({}).isAdmin);
  // also include Object.prototype properties so the demo can prove pollution
  res.json(Object.assign({}, defaults, Object.getOwnPropertyNames(Object.prototype).reduce((o,k)=>(o[k]=Object.prototype[k],o), {})));
});

// --- VULNERABILITY #4: Hardcoded JWT secret + alg:none style trust issue ---
app.post("/login", (req, res) => {
  const { username } = req.body;
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "1h" });
  res.json({ token });
});

app.post("/__debug__", (req, res) => { res.json({ body: req.body, bodyType: typeof req.body.path, bodyKeys: Object.keys(req.body), hasProtoKey: Object.prototype.hasOwnProperty.call(req.body, "__proto__") }); });
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`vulnerable-app listening on ${PORT}`));
}

module.exports = app;
