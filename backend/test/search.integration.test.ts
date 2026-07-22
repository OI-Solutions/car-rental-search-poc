/**
 * Live integration against the Phase 1 OpenSearch cluster. These tests prove the
 * real query + mappings work end-to-end. They SKIP automatically when the cluster
 * is unreachable, so `npm test` never fails just because Docker is down.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getOpenSearchClient } from "../src/opensearch/client.js";

const app = createApp();
let osUp = false;

beforeAll(async () => {
  try {
    await getOpenSearchClient().cluster.health({}, { requestTimeout: 3000 });
    osUp = true;
  } catch {
    osUp = false;
  }
});

async function token(userId: string): Promise<string> {
  const res = await request(app).post("/api/dev/session").send({ user_id: userId });
  return res.body.token as string;
}

describe("live protected search (skips if OpenSearch is down)", () => {
  it("(#4) CUS-001 and CUS-002 get different SUV prices from real data", async (ctx) => {
    if (!osUp) ctx.skip();
    const [t1, t2] = [await token("USR-001-C"), await token("USR-002-C")];
    const body = { vehicle_class: "suv", sort: "personalized_price_asc" };

    const r1 = await request(app).post("/api/search").set("Authorization", `Bearer ${t1}`).send(body);
    const r2 = await request(app).post("/api/search").set("Authorization", `Bearer ${t2}`).send(body);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.results.length).toBeGreaterThan(0);
    expect(r2.body.results.length).toBeGreaterThan(0);
    // Personalized pricing fires: CUS-001 has negotiated discounts, so at least one
    // SUV comes back below its base rate.
    expect(r1.body.results.some((r: { discount_percent: number }) => r.discount_percent > 0)).toBe(true);
    // Different tenants, different agreements → different personalized price vectors.
    const top = (r: { body: { results: { effective_daily_rate: number }[] } }) =>
      r.body.results.slice(0, 20).map((x) => x.effective_daily_rate);
    expect(top(r1)).not.toEqual(top(r2));
  });

  it("(#9) a dealership user sees only its own dealership from real data", async (ctx) => {
    if (!osUp) ctx.skip();
    const t = await token("USR-D01");
    const res = await request(app).post("/api/search").set("Authorization", `Bearer ${t}`).send({});
    expect(res.status).toBe(200);
    const dealers = new Set(res.body.results.map((r: { dealership_name: string }) => r.dealership_name));
    expect([...dealers]).toEqual(["Phoenix Fleet Center"]);
  });

  it("(#11) a corporate admin sees inventory across multiple dealerships", async (ctx) => {
    if (!osUp) ctx.skip();
    const t = await token("USR-ADM-01");
    const res = await request(app).post("/api/search").set("Authorization", `Bearer ${t}`).send({});
    expect(res.status).toBe(200);
    const dealers = new Set(res.body.results.map((r: { dealership_name: string }) => r.dealership_name));
    expect(dealers.size).toBeGreaterThan(1);
  });
});
