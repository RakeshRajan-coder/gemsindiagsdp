const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const { createApp, createDatabase, migrateRatesToInr } = require("../server");

const providerRequests = [];
const app = createApp({
  dbPath: ":memory:", jwtSecret: "test-secret-with-more-than-thirty-two-bytes",
  rateUpdateToken: "test-rate-update-token", adminApiToken: "test-admin-token",
  adminUsername: "test-admin", adminPasswordHash: bcrypt.hashSync("a-secure-test-passphrase", 4),
  goldApiKey: "goldapi-test-key", goldApiBaseUrl: "https://gold.example/api",
  fxDataUrl: "https://fx.example/latest/USD", diamondGuidePriceInr: 100000,
  fetch: async (url, options) => {
    providerRequests.push({ url: String(url), options });
    if (String(url).includes("/api/XAU/INR")) return { ok: true, json: async () => ({ price: 200000, chp: 1.2 }) };
    if (String(url).includes("/api/XAG/INR")) return { ok: true, json: async () => ({ price: 2500, chp: 0.4 }) };
    if (String(url).includes("/api/XPT/INR")) return { ok: true, json: async () => ({ price: 90000, chp: -0.5 }) };
    if (String(url).includes("fx.example")) return { ok: true, json: async () => ({ base_code: "USD", rates: { INR: 84.25 } }) };
    throw new Error(`Unexpected provider URL: ${url}`);
  }
});
const server = app.listen(0);
const client = request(server);

after(() => new Promise((resolve) => server.close(() => { app.locals.shutdown(); resolve(); })));

test("admin login uses a secure session cookie and protects store operations", async () => {
  const invalid = await client.post("/api/admin/login").send({ username: "test-admin", password: "wrong-password" });
  assert.equal(invalid.status, 401);

  const login = await client.post("/api/admin/login").send({ username: "test-admin", password: "a-secure-test-passphrase" });
  assert.equal(login.status, 200);
  assert.match(login.headers["set-cookie"][0], /HttpOnly/);
  assert.match(login.headers["set-cookie"][0], /SameSite=Strict/);
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const session = await client.get("/api/admin/session").set("Cookie", cookie);
  assert.equal(session.status, 200);
  const stats = await client.get("/api/admin/stores/stats").set("Cookie", cookie);
  assert.equal(stats.status, 200);

  const logout = await client.post("/api/admin/logout").set("Cookie", cookie);
  assert.equal(logout.status, 204);
  assert.match(logout.headers["set-cookie"][0], /Max-Age=0/);
  const expiredSession = await client.get("/api/admin/session").set("Cookie", cookie);
  assert.equal(expiredSession.status, 401);
});

test("registers a merchant, creates a secure session, and allows logout", async () => {
  const registration = await client.post("/api/auth/register").send({
    name: "A Merchant", company: "Precious Goods Ltd", email: "merchant@example.com", password: "a-secure-passphrase-47"
  });
  assert.equal(registration.status, 201);
  assert.match(registration.headers["set-cookie"][0], /HttpOnly/);
  assert.match(registration.headers["set-cookie"][0], /SameSite=Strict/);
  assert.equal(registration.body.merchant.email, "merchant@example.com");

  const cookie = registration.headers["set-cookie"][0].split(";")[0];
  const current = await client.get("/api/auth/me").set("Cookie", cookie);
  assert.equal(current.status, 200);
  assert.equal(current.body.merchant.company, "Precious Goods Ltd");

  const logout = await client.post("/api/auth/logout");
  assert.equal(logout.status, 204);
  assert.match(logout.headers["set-cookie"][0], /Max-Age=0/);

  const login = await client.post("/api/auth/login").send({ email: "MERCHANT@example.com", password: "a-secure-passphrase-47" });
  assert.equal(login.status, 200);
  assert.equal(login.body.merchant.email, "merchant@example.com");
  const invalidLogin = await client.post("/api/auth/login").send({ email: "merchant@example.com", password: "wrong-passphrase" });
  assert.equal(invalidLogin.status, 401);
});

test("rejects weak passwords and duplicate merchant emails", async () => {
  const weak = await client.post("/api/auth/register").send({
    name: "Another Merchant", company: "Another Ltd", email: "another@example.com", password: "short"
  });
  assert.equal(weak.status, 400);

  const duplicate = await client.post("/api/auth/register").send({
    name: "Duplicate", company: "Duplicate Ltd", email: "MERCHANT@example.com", password: "another-secure-passphrase"
  });
  assert.equal(duplicate.status, 409);
});

test("updates and returns commodity rates only with the configured token", async () => {
  const payload = { rates: [{ commodity: "gold", price: 200000, unit: "INR/troy oz", currency: "INR", changePercent: 1.2 }] };
  const unauthorized = await client.post("/api/admin/rates").send(payload);
  assert.equal(unauthorized.status, 401);
  const usdQuote = await client.post("/api/admin/rates").set("Authorization", "Bearer test-rate-update-token").send({
    rates: [{ commodity: "gold", price: 2400, unit: "USD/troy oz", currency: "USD" }]
  });
  assert.equal(usdQuote.status, 400);

  const update = await client.post("/api/admin/rates").set("Authorization", "Bearer test-rate-update-token").send(payload);
  assert.equal(update.status, 200);
  assert.equal(update.body.rates.find((rate) => rate.commodity === "gold").price, 200000);
  assert.equal(update.body.rates.find((rate) => rate.commodity === "gold").source, "admin");

  const rates = await client.get("/api/rates");
  assert.equal(rates.status, 200);
  assert.equal(rates.body.rates.length, 4);
  assert.equal(rates.body.live, false);
  assert.equal(rates.body.forex.usdInrRate, 83.5);
  assert.equal(rates.body.forexLive, false);
});

test("migrates existing USD market rates into INR exactly once", () => {
  const db = createDatabase(":memory:");
  try {
    db.prepare("UPDATE market_rates SET price = 2400, unit = 'USD/troy oz', currency = 'USD' WHERE commodity = 'gold'").run();
    assert.equal(migrateRatesToInr(db, 84), 1);
    const gold = db.prepare("SELECT price, unit, currency FROM market_rates WHERE commodity = 'gold'").get();
    assert.deepEqual(gold, { price: 201600, unit: "INR/troy oz", currency: "INR" });
    assert.equal(migrateRatesToInr(db, 84), 0);
    assert.equal(db.prepare("SELECT price FROM market_rates WHERE commodity = 'gold'").get().price, 201600);
  } finally { db.close(); }
});

test("fetches GoldAPI metal quotes and a separate live USD/INR forex rate", async () => {
  const rates = await app.locals.refreshGoldApiPrices();
  assert.deepEqual(providerRequests.slice(0, 3).map((call) => call.url), [
    "https://gold.example/api/XAU/INR", "https://gold.example/api/XAG/INR", "https://gold.example/api/XPT/INR"
  ]);
  assert.ok(providerRequests.slice(0, 3).every((call) => call.options.headers["x-access-token"] === "goldapi-test-key"));
  assert.equal(rates.find((rate) => rate.commodity === "gold").price, 200000);
  assert.equal(rates.find((rate) => rate.commodity === "platinum").currency, "INR");
  assert.equal(rates.find((rate) => rate.commodity === "diamond").source, "guide");

  const forex = await app.locals.refreshForexRate();
  assert.equal(forex.usdInrRate, 84.25);
  const apiResult = await client.get("/api/rates");
  assert.equal(apiResult.body.live, true);
  assert.equal(apiResult.body.forexLive, true);
});

test("seeds demo stores and allows admins to replace and approve them safely", async () => {
  const unauthorized = await client.get("/api/admin/stores/stats");
  assert.equal(unauthorized.status, 401);
  const seed = app.locals.seedDummyStores(125, 25);
  assert.deepEqual(seed, { inserted: 125, firstId: 1, lastId: 125 });

  const stats = await client.get("/api/admin/stores/stats").set("Authorization", "Bearer test-admin-token");
  assert.equal(stats.body.stats.total, 125);
  assert.equal(stats.body.stats.dummy, 125);

  const filtered = await client.get("/api/admin/stores?limit=20&country=India&metal=gold&dummy=true")
    .set("Authorization", "Bearer test-admin-token");
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.stores.length <= 20);
  assert.ok(filtered.body.stores.every((store) => store.country === "India" && store.isDummy && store.availableMetals.includes("gold")));

  const pageOne = await client.get("/api/admin/stores?limit=20&dummy=true").set("Authorization", "Bearer test-admin-token");
  const pageTwo = await client.get(`/api/admin/stores?limit=20&dummy=true&after=${pageOne.body.nextCursor}`)
    .set("Authorization", "Bearer test-admin-token");
  assert.ok(pageOne.body.nextCursor);
  assert.ok(pageTwo.body.stores[0].id > pageOne.body.stores.at(-1).id);

  const firstPage = await client.get("/api/admin/stores?limit=2&q=Demo%20Store%20000001").set("Authorization", "Bearer test-admin-token");
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.stores.length, 1);
  assert.match(firstPage.body.stores[0].shopName, /^Demo Store/);
  const storeId = firstPage.body.stores[0].id;

  const cannotApproveDummy = await client.post(`/api/admin/stores/${storeId}/approve`).set("Authorization", "Bearer test-admin-token");
  assert.equal(cannotApproveDummy.status, 409);

  const replacement = await client.patch(`/api/admin/stores/${storeId}/replace`).set("Authorization", "Bearer test-admin-token").send({
    shopName: "Real Mumbai Metals", city: "Mumbai", country: "India", owner: "A Merchant", availableMetals: ["gold", "silver"]
  });
  assert.equal(replacement.status, 200);
  assert.equal(replacement.body.store.isDummy, false);
  assert.equal(replacement.body.store.status, "pending");

  const approval = await client.post(`/api/admin/stores/${storeId}/approve`).set("Authorization", "Bearer test-admin-token");
  assert.equal(approval.status, 200);
  assert.equal(approval.body.store.status, "approved");

  const realDelete = await client.delete(`/api/admin/stores/${storeId}`).set("Authorization", "Bearer test-admin-token");
  assert.equal(realDelete.status, 409);

  const created = await client.post("/api/admin/stores").set("Authorization", "Bearer test-admin-token").send({
    shopName: "New Gem House", city: "Surat", country: "India", owner: "Another Merchant", availableMetals: ["diamond"]
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.store.isDummy, false);
  assert.equal(created.body.store.status, "pending");
});