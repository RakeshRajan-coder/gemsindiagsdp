const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");

const SESSION_COOKIE = "tradecenter_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const USD_INR_DEFAULT = 83.5;
const RATE_DEFAULTS = [
  { commodity: "gold", price: 195540.3, unit: "INR/troy oz", currency: "INR", changePercent: 0.42 },
  { commodity: "silver", price: 2433.19, unit: "INR/troy oz", currency: "INR", changePercent: 0.18 },
  { commodity: "diamond", price: 375750, unit: "INR/carat guide", currency: "INR", changePercent: null },
  { commodity: "platinum", price: 84552.1, unit: "INR/troy oz", currency: "INR", changePercent: -0.26 }
];
const COMMODITIES = new Set(RATE_DEFAULTS.map((rate) => rate.commodity));

function migrateRatesToInr(db, usdInrRate = USD_INR_DEFAULT) {
  const legacyRows = db.prepare("SELECT COUNT(*) AS count FROM market_rates WHERE currency <> 'INR'").get().count;
  if (legacyRows > 0) {
    db.prepare(`UPDATE market_rates SET price = price * ?,
      unit = CASE WHEN unit LIKE 'USD/%' THEN 'INR/' || substr(unit, 5) ELSE unit END,
      currency = 'INR' WHERE currency <> 'INR'`).run(usdInrRate);
  }
  return legacyRows;
}

function createDatabase(dbPath = process.env.DB_PATH || path.join(__dirname, "data", "tradecenter.sqlite")) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS market_rates (
      commodity TEXT PRIMARY KEY,
      price REAL NOT NULL CHECK (price > 0),
      unit TEXT NOT NULL,
      currency TEXT NOT NULL,
      change_percent REAL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forex_rates (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      usd_inr_rate REAL NOT NULL CHECK (usd_inr_rate > 0),
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS merchant_stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_name TEXT NOT NULL,
      location_city TEXT NOT NULL,
      location_country TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      available_metals TEXT NOT NULL CHECK (json_valid(available_metals)),
      is_dummy INTEGER NOT NULL DEFAULT 0 CHECK (is_dummy IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stores_status_id ON merchant_stores(status, id);
    CREATE INDEX IF NOT EXISTS idx_stores_country_id ON merchant_stores(location_country, id);
    CREATE INDEX IF NOT EXISTS idx_stores_dummy_id ON merchant_stores(is_dummy, id);
    CREATE TABLE IF NOT EXISTS store_metals (
      store_id INTEGER NOT NULL REFERENCES merchant_stores(id) ON DELETE CASCADE,
      metal TEXT NOT NULL CHECK (metal IN ('gold', 'silver', 'diamond', 'platinum')),
      PRIMARY KEY (store_id, metal)
    );
    CREATE INDEX IF NOT EXISTS idx_store_metals_metal_id ON store_metals(metal, store_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS merchant_stores_fts USING fts5(
      shop_name, location_city, location_country, owner_name,
      tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3 4'
    );
    CREATE TRIGGER IF NOT EXISTS stores_fts_after_insert AFTER INSERT ON merchant_stores BEGIN
      INSERT INTO merchant_stores_fts(rowid, shop_name, location_city, location_country, owner_name)
      VALUES (new.id, new.shop_name, new.location_city, new.location_country, new.owner_name);
    END;
    CREATE TRIGGER IF NOT EXISTS stores_fts_after_delete AFTER DELETE ON merchant_stores BEGIN
      DELETE FROM merchant_stores_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS stores_fts_after_update AFTER UPDATE OF shop_name, location_city, location_country, owner_name ON merchant_stores BEGIN
      DELETE FROM merchant_stores_fts WHERE rowid = old.id;
      INSERT INTO merchant_stores_fts(rowid, shop_name, location_city, location_country, owner_name)
      VALUES (new.id, new.shop_name, new.location_city, new.location_country, new.owner_name);
    END;
  `);
  const count = db.prepare("SELECT COUNT(*) AS count FROM market_rates").get().count;
  if (count === 0) {
    const insert = db.prepare(`INSERT INTO market_rates
      (commodity, price, unit, currency, change_percent, source, updated_at)
      VALUES (@commodity, @price, @unit, @currency, @changePercent, 'demo', @updatedAt)`);
    const seed = db.transaction(() => RATE_DEFAULTS.forEach((rate) => insert.run({ ...rate, updatedAt: new Date().toISOString() })));
    seed();
  }
  migrateRatesToInr(db);
  db.prepare(`INSERT INTO forex_rates (id, usd_inr_rate, source, updated_at)
    VALUES (1, ?, 'demo', ?) ON CONFLICT(id) DO NOTHING`).run(USD_INR_DEFAULT, new Date().toISOString());
  return db;
}

function seedDummyStores(db, count = 100000, batchSize = 2000, onProgress = () => {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new Error("count must be between 1 and 1000000");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000) throw new Error("batchSize must be between 1 and 10000");
  const locations = [
    ["Mumbai", "India"], ["Surat", "India"], ["Jaipur", "India"], ["Delhi", "India"],
    ["Bangkok", "Thailand"], ["Chanthaburi", "Thailand"], ["Hong Kong", "Hong Kong"],
    ["Singapore", "Singapore"], ["Dubai", "United Arab Emirates"], ["London", "United Kingdom"],
    ["Antwerp", "Belgium"], ["New York", "United States"], ["Johannesburg", "South Africa"],
    ["Cape Town", "South Africa"], ["Perth", "Australia"], ["Sydney", "Australia"]
  ];
  const metals = ["gold", "silver", "diamond", "platinum"];
  const maximumId = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM merchant_stores").get().id;
  const sequenceId = db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'merchant_stores'), 0) AS id").get().id;
  const nextId = Math.max(maximumId, sequenceId) + 1;
  const insertStore = db.prepare(`INSERT INTO merchant_stores
    (shop_name, location_city, location_country, owner_name, available_metals, is_dummy, status)
    VALUES (@shopName, @city, @country, @owner, @availableMetals, 1, 'pending')`);
  const insertMetal = db.prepare("INSERT INTO store_metals (store_id, metal) VALUES (?, ?)");
  const insertBatch = db.transaction((start, length) => {
    for (let offset = 0; offset < length; offset += 1) {
      const serial = start + offset;
      const location = locations[(serial - 1) % locations.length];
      const availableMetals = metals.filter((_metal, index) => ((serial % 15) + 1) & (1 << index));
      const result = insertStore.run({
        shopName: `Demo Store ${String(serial).padStart(6, "0")}`,
        city: location[0], country: location[1],
        owner: `Demo Owner ${String(serial).padStart(6, "0")}`,
        availableMetals: JSON.stringify(availableMetals)
      });
      for (const metal of availableMetals) insertMetal.run(Number(result.lastInsertRowid), metal);
    }
  });
  for (let inserted = 0; inserted < count; inserted += batchSize) {
    const batchCount = Math.min(batchSize, count - inserted);
    insertBatch(nextId + inserted, batchCount);
    onProgress(inserted + batchCount, count);
  }
  return { inserted: count, firstId: nextId, lastId: nextId + count - 1 };
}

function normalizeStore(input) {
  const shopName = typeof input?.shopName === "string" ? input.shopName.trim() : "";
  const city = typeof input?.city === "string" ? input.city.trim() : "";
  const country = typeof input?.country === "string" ? input.country.trim() : "";
  const owner = typeof input?.owner === "string" ? input.owner.trim() : "";
  const availableMetals = input?.availableMetals;
  if (!shopName || shopName.length > 160 || !city || city.length > 100 ||
    !country || country.length > 100 || !owner || owner.length > 120) {
    throw new Error("Shop name, city, country, and owner are required and must be within length limits");
  }
  if (!Array.isArray(availableMetals) || availableMetals.length < 1 || availableMetals.length > 4 ||
    availableMetals.some((metal) => !COMMODITIES.has(metal)) || new Set(availableMetals).size !== availableMetals.length) {
    throw new Error("availableMetals must contain one or more unique supported metals");
  }
  return { shopName, city, country, owner, availableMetals };
}

function ftsQuery(value) {
  const terms = value.match(/[\p{L}\p{N}]+/gu) || [];
  return terms.slice(0, 8).map((term) => `"${term}"*`).join(" AND ");
}

function normalizeRates(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 4) {
    throw new Error("rates must be a non-empty array with at most four entries");
  }
  const seen = new Set();
  return input.map((item) => {
    const commodity = typeof item?.commodity === "string" ? item.commodity.trim().toLowerCase() : "";
    const price = Number(item?.price);
    const unit = typeof item?.unit === "string" ? item.unit.trim() : "";
    const currency = typeof item?.currency === "string" ? item.currency.trim().toUpperCase() : "INR";
    const changePercent = item?.changePercent == null ? null : Number(item.changePercent);
    if (!COMMODITIES.has(commodity) || seen.has(commodity)) throw new Error("Each commodity must be one unique supported rate");
    if (!Number.isFinite(price) || price <= 0 || price > 1e12) throw new Error(`Invalid price for ${commodity}`);
    if (!unit || unit.length > 40 || currency !== "INR" || !unit.startsWith("INR/")) {
      throw new Error(`Rates for ${commodity} must use INR pricing and units`);
    }
    if (changePercent !== null && (!Number.isFinite(changePercent) || Math.abs(changePercent) > 10000)) {
      throw new Error(`Invalid changePercent for ${commodity}`);
    }
    seen.add(commodity);
    return { commodity, price, unit, currency, changePercent };
  });
}

function storeRates(db, input, source) {
  const rates = normalizeRates(input);
  const updatedAt = new Date().toISOString();
  const upsert = db.prepare(`INSERT INTO market_rates
    (commodity, price, unit, currency, change_percent, source, updated_at)
    VALUES (@commodity, @price, @unit, @currency, @changePercent, @source, @updatedAt)
    ON CONFLICT(commodity) DO UPDATE SET price = excluded.price, unit = excluded.unit,
      currency = excluded.currency, change_percent = excluded.change_percent,
      source = excluded.source, updated_at = excluded.updated_at`);
  db.transaction(() => rates.forEach((rate) => upsert.run({ ...rate, source, updatedAt })))();
  return getRates(db);
}

function getRates(db) {
  return db.prepare(`SELECT commodity, price, unit, currency,
      change_percent AS changePercent, source, updated_at AS updatedAt
    FROM market_rates
    ORDER BY CASE commodity WHEN 'gold' THEN 1 WHEN 'silver' THEN 2 WHEN 'diamond' THEN 3 ELSE 4 END`).all();
}

function getForexRate(db) {
  return db.prepare(`SELECT usd_inr_rate AS usdInrRate, source, updated_at AS updatedAt
    FROM forex_rates WHERE id = 1`).get();
}

function readCookie(request, name) {
  const cookies = request.headers.cookie || "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ""; }
  }
  return "";
}

function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`);
}

function clearSessionCookie(response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function createApp(options = {}) {
  const db = options.db || createDatabase(options.dbPath);
  const ownsDatabase = !options.db;
  const jwtSecret = options.jwtSecret || process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
  const rateUpdateToken = options.rateUpdateToken ?? process.env.RATE_UPDATE_TOKEN ?? "";
  const adminApiToken = options.adminApiToken ?? process.env.ADMIN_API_TOKEN ?? "";
  const goldApiBaseUrl = options.goldApiBaseUrl ?? process.env.GOLDAPI_BASE_URL ?? "https://www.goldapi.io/api";
  const goldApiKey = options.goldApiKey ?? process.env.GOLDAPI_API_KEY ?? "";
  const fxDataUrl = options.fxDataUrl ?? process.env.FX_DATA_URL ?? "https://open.er-api.com/v6/latest/USD";
  const diamondGuidePriceInr = Number(options.diamondGuidePriceInr ?? process.env.DIAMOND_GUIDE_PRICE_INR) || null;
  const fetchData = options.fetch ?? globalThis.fetch;
  const clients = new Set();
  const app = express();
  if (diamondGuidePriceInr) {
    storeRates(db, [{ commodity: "diamond", price: diamondGuidePriceInr, unit: "INR/carat guide", currency: "INR", changePercent: null }], "guide");
  }

  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "https://images.unsplash.com", "data:"], connectSrc: ["'self'"]
    } }
  }));
  app.use(express.json({ limit: "10kb" }));
  app.get("/", (_request, response) => response.sendFile(path.join(__dirname, "index.html")));
  app.get("/admin", (_request, response) => response.sendFile(path.join(__dirname, "admin.html")));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
  const getMerchant = (id) => db.prepare("SELECT id, name, company, email, created_at AS createdAt FROM merchants WHERE id = ?").get(id);
  const requireMerchant = (request, response, next) => {
    try {
      const token = readCookie(request, SESSION_COOKIE);
      if (!token) return response.status(401).json({ error: "Authentication required" });
      const payload = jwt.verify(token, jwtSecret, { issuer: "tradecenter", audience: "tradecenter-merchant" });
      const merchant = getMerchant(Number(payload.sub));
      if (!merchant) return response.status(401).json({ error: "Authentication required" });
      request.merchant = merchant;
      return next();
    } catch {
      return response.status(401).json({ error: "Authentication required" });
    }
  };
  const requireAdmin = (request, response, next) => {
    if (!adminApiToken) return response.status(503).json({ error: "Admin access is not configured" });
    const supplied = Buffer.from(request.get("authorization")?.replace(/^Bearer\s+/i, "") || "");
    const expected = Buffer.from(adminApiToken);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return response.status(401).json({ error: "Admin authentication required" });
    }
    return next();
  };

  const getStore = db.prepare(`SELECT id, shop_name AS shopName, location_city AS city,
    location_country AS country, owner_name AS owner, available_metals AS availableMetals,
    is_dummy AS isDummy, status, created_at AS createdAt, updated_at AS updatedAt
    FROM merchant_stores WHERE id = ?`);

  app.get("/api/admin/stores/stats", requireAdmin, (_request, response) => {
    const stats = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN is_dummy = 1 THEN 1 ELSE 0 END) AS dummy,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
      FROM merchant_stores`).get();
    return response.json({ stats });
  });

  app.get("/api/admin/stores/:id", requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Invalid store id" });
    const store = getStore.get(id);
    if (!store) return response.status(404).json({ error: "Store not found" });
    return response.json({ store: { ...store, isDummy: Boolean(store.isDummy), availableMetals: JSON.parse(store.availableMetals) } });
  });

  app.get("/api/admin/stores", requireAdmin, (request, response) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit, 10) || 50));
    const afterId = Math.max(0, Number.parseInt(request.query.after, 10) || 0);
    const clauses = ["s.id > ?"];
    const params = [afterId];
    if (["pending", "approved", "rejected"].includes(request.query.status)) {
      clauses.push("s.status = ?"); params.push(request.query.status);
    }
    if (typeof request.query.country === "string" && request.query.country.trim()) {
      clauses.push("s.location_country = ?"); params.push(request.query.country.trim().slice(0, 100));
    }
    if (request.query.dummy === "true" || request.query.dummy === "false") {
      clauses.push("s.is_dummy = ?"); params.push(request.query.dummy === "true" ? 1 : 0);
    }
    if (typeof request.query.metal === "string" && COMMODITIES.has(request.query.metal)) {
      clauses.push("EXISTS (SELECT 1 FROM store_metals sm WHERE sm.store_id = s.id AND sm.metal = ?)");
      params.push(request.query.metal);
    }
    const search = typeof request.query.q === "string" ? ftsQuery(request.query.q.slice(0, 120)) : "";
    if (search) {
      clauses.push("s.id IN (SELECT rowid FROM merchant_stores_fts WHERE merchant_stores_fts MATCH ?)");
      params.push(search);
    }
    const rows = db.prepare(`SELECT s.id, s.shop_name AS shopName, s.location_city AS city,
      s.location_country AS country, s.owner_name AS owner, s.available_metals AS availableMetals,
      s.is_dummy AS isDummy, s.status, s.created_at AS createdAt, s.updated_at AS updatedAt
      FROM merchant_stores s WHERE ${clauses.join(" AND ")} ORDER BY s.id LIMIT ?`).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return response.json({ stores: rows.map((row) => ({ ...row, isDummy: Boolean(row.isDummy), availableMetals: JSON.parse(row.availableMetals) })),
      nextCursor: hasMore ? rows.at(-1).id : null });
  });

  app.post("/api/admin/stores", requireAdmin, (request, response) => {
    let store;
    try { store = normalizeStore(request.body); }
    catch (error) { return response.status(400).json({ error: error.message }); }
    const createStore = db.transaction(() => {
      const result = db.prepare(`INSERT INTO merchant_stores
        (shop_name, location_city, location_country, owner_name, available_metals, is_dummy, status)
        VALUES (?, ?, ?, ?, ?, 0, 'pending')`).run(store.shopName, store.city, store.country, store.owner, JSON.stringify(store.availableMetals));
      const insertMetal = db.prepare("INSERT INTO store_metals (store_id, metal) VALUES (?, ?)");
      store.availableMetals.forEach((metal) => insertMetal.run(Number(result.lastInsertRowid), metal));
      return Number(result.lastInsertRowid);
    });
    const id = createStore();
    return response.status(201).json({ store: { ...getStore.get(id), isDummy: false, availableMetals: store.availableMetals } });
  });

  app.post("/api/admin/stores/:id/approve", requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Invalid store id" });
    const store = getStore.get(id);
    if (!store) return response.status(404).json({ error: "Store not found" });
    if (store.isDummy) return response.status(409).json({ error: "Replace the demo store before approving it" });
    db.prepare("UPDATE merchant_stores SET status = 'approved', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return response.json({ store: { ...getStore.get(id), isDummy: false, availableMetals: JSON.parse(store.availableMetals) } });
  });

  app.post("/api/admin/stores/:id/reject", requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Invalid store id" });
    const result = db.prepare("UPDATE merchant_stores SET status = 'rejected', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (!result.changes) return response.status(404).json({ error: "Store not found" });
    const store = getStore.get(id);
    return response.json({ store: { ...store, isDummy: Boolean(store.isDummy), availableMetals: JSON.parse(store.availableMetals) } });
  });

  app.patch("/api/admin/stores/:id/replace", requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Invalid store id" });
    let store;
    try { store = normalizeStore(request.body); }
    catch (error) { return response.status(400).json({ error: error.message }); }
    const replaceStore = db.transaction(() => {
      const result = db.prepare(`UPDATE merchant_stores SET shop_name = ?, location_city = ?, location_country = ?,
        owner_name = ?, available_metals = ?, is_dummy = 0, status = 'pending', updated_at = ?
        WHERE id = ? AND is_dummy = 1`).run(store.shopName, store.city, store.country, store.owner,
        JSON.stringify(store.availableMetals), new Date().toISOString(), id);
      if (!result.changes) return false;
      db.prepare("DELETE FROM store_metals WHERE store_id = ?").run(id);
      const insertMetal = db.prepare("INSERT INTO store_metals (store_id, metal) VALUES (?, ?)");
      store.availableMetals.forEach((metal) => insertMetal.run(id, metal));
      return true;
    });
    if (!replaceStore()) {
      return response.status(getStore.get(id) ? 409 : 404).json({ error: "Store is missing or is no longer a demo store" });
    }
    return response.json({ store: { ...getStore.get(id), isDummy: false, availableMetals: store.availableMetals } });
  });

  app.delete("/api/admin/stores/:id", requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Invalid store id" });
    const result = db.prepare("DELETE FROM merchant_stores WHERE id = ? AND is_dummy = 1").run(id);
    if (!result.changes) return response.status(getStore.get(id) ? 409 : 404).json({ error: "Store is missing or is not a demo store" });
    return response.status(204).end();
  });

  app.post("/api/auth/register", authLimiter, async (request, response) => {
    const { name, company, email, password } = request.body || {};
    if ([name, company, email, password].some((value) => typeof value !== "string")) {
      return response.status(400).json({ error: "Name, company, email, and password are required" });
    }
    const cleanName = name.trim();
    const cleanCompany = company.trim();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanName || cleanName.length > 100 || !cleanCompany || cleanCompany.length > 160 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) {
      return response.status(400).json({ error: "Enter a valid name, company, and email" });
    }
    if ([...password].length < 12 || Buffer.byteLength(password, "utf8") > 72) {
      return response.status(400).json({ error: "Password must be at least 12 characters and no more than 72 bytes" });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const result = db.prepare("INSERT INTO merchants (name, company, email, password_hash) VALUES (?, ?, ?, ?)")
        .run(cleanName, cleanCompany, cleanEmail, passwordHash);
      const merchant = getMerchant(Number(result.lastInsertRowid));
      const token = jwt.sign({}, jwtSecret, { subject: String(merchant.id), issuer: "tradecenter", audience: "tradecenter-merchant", expiresIn: SESSION_TTL_SECONDS });
      setSessionCookie(response, token);
      return response.status(201).json({ merchant });
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return response.status(409).json({ error: "Unable to create account with those details" });
      throw error;
    }
  });

  app.post("/api/auth/login", authLimiter, async (request, response) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const record = email.length <= 254 ? db.prepare("SELECT id, password_hash AS passwordHash FROM merchants WHERE email = ?").get(email) : null;
    const valid = record ? await bcrypt.compare(password, record.passwordHash) : false;
    if (!valid) return response.status(401).json({ error: "Email or password is incorrect" });
    const merchant = getMerchant(record.id);
    const token = jwt.sign({}, jwtSecret, { subject: String(merchant.id), issuer: "tradecenter", audience: "tradecenter-merchant", expiresIn: SESSION_TTL_SECONDS });
    setSessionCookie(response, token);
    return response.json({ merchant });
  });

  app.get("/api/auth/me", requireMerchant, (request, response) => response.json({ merchant: request.merchant }));
  app.post("/api/auth/logout", (_request, response) => {
    clearSessionCookie(response);
    response.status(204).end();
  });
  app.get("/api/rates", (_request, response) => {
    const rates = getRates(db);
    const forex = getForexRate(db);
    response.set("Cache-Control", "no-store").json({
      rates, forex, live: rates.some((rate) => rate.source === "goldapi"), forexLive: forex.source === "provider"
    });
  });
  app.get("/api/rates/stream", (request, response) => {
    response.status(200).set({
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no"
    });
    response.flushHeaders();
    clients.add(response);
    response.write(`event: rates\ndata: ${JSON.stringify({ rates: getRates(db) })}\n\n`);
    response.write(`event: forex\ndata: ${JSON.stringify({ forex: getForexRate(db) })}\n\n`);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25000);
    request.on("close", () => { clearInterval(heartbeat); clients.delete(response); });
  });

  function publishRates(rates) {
    const message = `event: rates\ndata: ${JSON.stringify({ rates })}\n\n`;
    for (const client of clients) client.write(message);
  }

  function updateRates(input, source = "admin") {
    const rates = storeRates(db, input, source);
    publishRates(rates);
    return rates;
  }

  function updateForexRate(rate, source = "provider") {
    const usdInrRate = Number(rate);
    if (!Number.isFinite(usdInrRate) || usdInrRate < 1 || usdInrRate > 1000) {
      throw new Error("USD/INR rate must be a positive rate between 1 and 1000");
    }
    const updatedAt = new Date().toISOString();
    db.prepare(`INSERT INTO forex_rates (id, usd_inr_rate, source, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET usd_inr_rate = excluded.usd_inr_rate,
        source = excluded.source, updated_at = excluded.updated_at`).run(usdInrRate, source, updatedAt);
    const forex = getForexRate(db);
    const message = `event: forex\ndata: ${JSON.stringify({ forex })}\n\n`;
    for (const client of clients) client.write(message);
    return forex;
  }

  async function refreshGoldApiPrices() {
    if (!goldApiKey) throw new Error("GOLDAPI_API_KEY is not configured");
    const url = new URL(goldApiBaseUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new Error("GOLDAPI_BASE_URL must use HTTPS");
    }
    const symbols = [{ commodity: "gold", symbol: "XAU" }, { commodity: "silver", symbol: "XAG" }, { commodity: "platinum", symbol: "XPT" }];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const quotes = await Promise.all(symbols.map(async ({ commodity, symbol }) => {
        const quoteUrl = new URL(`${symbol}/INR`, `${url.toString().replace(/\/$/, "")}/`);
        const result = await fetchData(quoteUrl, { headers: { Accept: "application/json", "x-access-token": goldApiKey }, signal: controller.signal });
        if (!result.ok) throw new Error(`GoldAPI ${symbol}/INR returned HTTP ${result.status}`);
        const body = await result.json();
        return {
          commodity, price: Number(body.price), unit: "INR/troy oz", currency: "INR",
          changePercent: body.chp != null && Number.isFinite(Number(body.chp)) ? Number(body.chp) : null
        };
      }));
      const rates = updateRates(quotes, "goldapi");
      if (diamondGuidePriceInr) {
        updateRates([{
          commodity: "diamond", price: diamondGuidePriceInr, unit: "INR/carat guide", currency: "INR", changePercent: null
        }], "guide");
      }
      return getRates(db);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refreshForexRate() {
    const url = new URL(fxDataUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new Error("FX_DATA_URL must use HTTPS");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const result = await fetchData(url, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (!result.ok) throw new Error(`FX provider returned HTTP ${result.status}`);
      const body = await result.json();
      const base = String(body.base_code || body.base || "USD").toUpperCase();
      const rates = body.rates || {};
      const usdInrRate = base === "INR" ? 1 / Number(rates.USD) : Number(rates.INR);
      return updateForexRate(usdInrRate, "provider");
    } finally {
      clearTimeout(timeout);
    }
  }

  app.post("/api/admin/rates", (request, response) => {
    if (!rateUpdateToken) return response.status(503).json({ error: "Rate update endpoint is not configured" });
    const supplied = Buffer.from(request.get("authorization")?.replace(/^Bearer\s+/i, "") || "");
    const expected = Buffer.from(rateUpdateToken);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return response.status(401).json({ error: "Invalid update credentials" });
    }
    try {
      if (!request.body || !Array.isArray(request.body.rates)) throw new Error("Request body must contain a rates array");
      const rates = updateRates(request.body.rates, "admin");
      return response.json({ rates, live: rates.some((rate) => rate.source === "goldapi") });
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  });
  app.post("/api/admin/forex", (request, response) => {
    if (!rateUpdateToken) return response.status(503).json({ error: "Rate update endpoint is not configured" });
    const supplied = Buffer.from(request.get("authorization")?.replace(/^Bearer\s+/i, "") || "");
    const expected = Buffer.from(rateUpdateToken);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return response.status(401).json({ error: "Invalid update credentials" });
    }
    try { return response.json({ forex: updateForexRate(request.body?.usdInrRate, "admin") }); }
    catch (error) { return response.status(400).json({ error: error.message }); }
  });

  app.locals.refreshGoldApiPrices = refreshGoldApiPrices;
  app.locals.refreshForexRate = refreshForexRate;
  app.locals.updateRates = updateRates;
  app.locals.updateForexRate = updateForexRate;
  app.locals.seedDummyStores = (count, batchSize, onProgress) => seedDummyStores(db, count, batchSize, onProgress);
  app.locals.shutdown = () => {
    for (const client of clients) client.end();
    clients.clear();
    if (ownsDatabase) db.close();
  };
  return app;
}

async function start() {
  if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET) < 32)) {
    throw new Error("Set JWT_SECRET to at least 32 bytes in production");
  }
  if (process.env.NODE_ENV === "production" && (!process.env.ADMIN_API_TOKEN || Buffer.byteLength(process.env.ADMIN_API_TOKEN) < 32)) {
    throw new Error("Set ADMIN_API_TOKEN to at least 32 bytes in production");
  }
  if (process.env.NODE_ENV === "production" && (!process.env.RATE_UPDATE_TOKEN || Buffer.byteLength(process.env.RATE_UPDATE_TOKEN) < 32)) {
    throw new Error("Set RATE_UPDATE_TOKEN to at least 32 bytes in production");
  }
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`Tradecenter listening on http://localhost:${port}`));
  const metalIntervalMs = Math.max(60000, Number(process.env.RATE_REFRESH_INTERVAL_MS) || 900000);
  const fxIntervalMs = Math.max(300000, Number(process.env.FX_REFRESH_INTERVAL_MS) || 3600000);
  const fxRefreshTimer = setInterval(() => app.locals.refreshForexRate().catch((error) => console.error(`FX rate refresh failed: ${error.message}`)), fxIntervalMs);
  fxRefreshTimer.unref();
  app.locals.refreshForexRate().catch((error) => console.error(`Initial FX rate refresh failed: ${error.message}`));
  let metalRefreshTimer;
  if (process.env.GOLDAPI_API_KEY) {
    app.locals.refreshGoldApiPrices().catch((error) => console.error(`GoldAPI rate refresh failed: ${error.message}`));
    metalRefreshTimer = setInterval(() => app.locals.refreshGoldApiPrices().catch((error) => console.error(`GoldAPI rate refresh failed: ${error.message}`)), metalIntervalMs);
    metalRefreshTimer.unref();
  }
  const shutdown = () => {
    clearInterval(fxRefreshTimer);
    clearInterval(metalRefreshTimer);
    server.close(() => { app.locals.shutdown(); process.exit(0); });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  start().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { createApp, createDatabase, migrateRatesToInr, normalizeRates, seedDummyStores };