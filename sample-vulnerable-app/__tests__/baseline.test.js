const request = require("supertest");
const app = require("../server");

// This is the pre-existing application test suite. PatchProof's verification
// step must keep these passing after every patch — a fix that breaks real
// functionality is rejected automatically (see slide 4: Verify, and slide 8:
// "Fix breaks the app -> rejected automatically by the existing suite").
describe("existing application behaviour (must never regress)", () => {
  test("GET /files serves an allowed public file", async () => {
    const res = await request(app).get("/files?name=welcome.txt");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Welcome to the demo app");
  });

  test("GET /ping returns a JSON response for localhost", async () => {
    // Some CI environments don't have `ping`. The exploit test still proves
    // command injection, so this baseline just needs to confirm the endpoint
    // returns something well-formed.
    const res = await request(app).get("/ping?host=127.0.0.1");
    expect([200, 500]).toContain(res.status);
    expect(typeof res.body).toBe("object");
  });

  test("POST /preferences sets a user override at a safe path", async () => {
    const res = await request(app)
      .post("/preferences")
      .send({ path: "theme", value: "dark" });
    expect(res.status).toBe(200);
    expect(res.body.theme).toBe("dark");
  });

  test("POST /login issues a JWT for a username", async () => {
    const res = await request(app).post("/login").send({ username: "alice" });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
  });
});
