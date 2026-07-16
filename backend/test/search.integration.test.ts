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
    // CUS-001 has a 28% Chicago-wide deal; its cheapest personalized SUV should be
    // strictly cheaper than CUS-002's cheapest.
    const cheapest1 = r1.body.results[0].effective_daily_rate;
    const cheapest2 = r2.body.results[0].effective_daily_rate;
    expect(cheapest1).toBeLessThan(cheapest2);
    // CUS-001 Chicago SUV base 92 -> 66.24 demonstrates the price inversion.
    expect(cheapest1).toBeCloseTo(66.24, 2);
  });

  it("(#9) a dealership user sees only its own dealership from real data", async (ctx) => {
    if (!osUp) ctx.skip();
    const t = await token("USR-JOL-D");
    const res = await request(app).post("/api/search").set("Authorization", `Bearer ${t}`).send({});
    expect(res.status).toBe(200);
    const dealers = new Set(res.body.results.map((r: { dealership_name: string }) => r.dealership_name));
    expect([...dealers]).toEqual(["Joliet Jobsite Vehicles"]);
  });

  it("(#11) a corporate admin sees inventory across multiple dealerships", async (ctx) => {
    if (!osUp) ctx.skip();
    const t = await token("USR-CORP-001");
    const res = await request(app).post("/api/search").set("Authorization", `Bearer ${t}`).send({});
    expect(res.status).toBe(200);
    const dealers = new Set(res.body.results.map((r: { dealership_name: string }) => r.dealership_name));
    expect(dealers.size).toBeGreaterThan(1);
  });
});
