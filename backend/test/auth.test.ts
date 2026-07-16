import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

async function tokenFor(userId: string): Promise<string> {
  const res = await request(app).post("/api/dev/session").send({ user_id: userId });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

describe("authentication & input validation (no OpenSearch required)", () => {
  it("(#1) rejects unauthenticated search requests with 401", async () => {
    const res = await request(app).post("/api/search").send({ vehicle_class: "suv" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
  });

  it("(#1) rejects a malformed/garbage bearer token with 401", async () => {
    const res = await request(app)
      .post("/api/search")
      .set("Authorization", "Bearer not-a-real-token")
      .send({});
    expect(res.status).toBe(401);
  });

  it("(#2) refuses to establish a session for an inactive user (403)", async () => {
    const res = await request(app).post("/api/dev/session").send({ user_id: "USR-012-C" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("inactive_user");
  });

  it("returns 404 for an unknown user", async () => {
    const res = await request(app).post("/api/dev/session").send({ user_id: "NOPE" });
    expect(res.status).toBe(404);
  });

  it("(#3) rejects a customer_id injected into the search body (identity cannot be overridden)", async () => {
    const token = await tokenFor("USR-002-C");
    const res = await request(app)
      .post("/api/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ vehicle_class: "suv", customer_id: "CUS-001" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("(#10) rejects a dealership_id injected into the search body", async () => {
    const token = await tokenFor("USR-JOL-D");
    const res = await request(app)
      .post("/api/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ dealership_id: "DLR-CHI" });
    expect(res.status).toBe(400);
  });

  it("(#13) rejects an unsupported sort value", async () => {
    const token = await tokenFor("USR-001-C");
    const res = await request(app)
      .post("/api/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ sort: "price_desc" });
    expect(res.status).toBe(400);
  });

  it("(#13) rejects malformed filters (wrong type / raw DSL)", async () => {
    const token = await tokenFor("USR-001-C");
    const res = await request(app)
      .post("/api/search")
      .set("Authorization", `Bearer ${token}`)
      .send({ vehicle_class: { term: { hacked: true } } });
    expect(res.status).toBe(400);
  });

  it("the dev session profile never leaks credentials or secrets", async () => {
    const res = await request(app).post("/api/dev/session").send({ user_id: "USR-001-C" });
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ role: "customer_user", tenant_id: "CUS-001" });
    expect(JSON.stringify(res.body.profile)).not.toMatch(/password|secret/i);
  });
});
