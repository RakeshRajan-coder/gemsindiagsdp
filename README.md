# Tradecenter

An online marketplace for gold, silver, diamonds, platinum, and gemstones.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
cp .env.example .env
```

Set `JWT_SECRET` and `RATE_UPDATE_TOKEN` in `.env` to independent random secrets before starting. Admin login uses `ADMIN_USERNAME` and a bcrypt `ADMIN_PASSWORD_HASH`; the local ignored `.env` is configured with the requested default account. Change that password before exposing the app beyond a trusted development environment. Add a GoldAPI.io key to `GOLDAPI_API_KEY` to enable live metal quotes. Start the server with `npm start`, then open `http://localhost:3000`. SQLite data is stored in `data/tradecenter.sqlite` by default. Run API tests with `npm test`.

## API

- `POST /api/auth/register` creates a merchant. JSON fields: `name`, `company`, `email`, and `password`. Passwords must be at least 12 characters. Registration also signs the merchant in.
- `POST /api/auth/login` accepts `email` and `password`, and sets an HttpOnly, SameSite=Strict session cookie.
- `GET /api/auth/me` returns the signed-in merchant; `POST /api/auth/logout` clears the session.
- `GET /api/rates` returns INR metal rates and the USD/INR exchange rate with source/update metadata.
- `GET /api/rates/stream` streams metal and forex changes as separate server-sent events.
- `POST /api/admin/rates` updates one or more rates. Supply `Authorization: Bearer $RATE_UPDATE_TOKEN` and JSON with a `rates` array. Supported commodities are `gold`, `silver`, `diamond`, and `platinum`; all prices and units must be INR.
- `POST /api/admin/forex` updates USD/INR using the same rate-update token and a JSON `usdInrRate` value.

When `GOLDAPI_API_KEY` is set, the server fetches GoldAPI.io `XAU/INR`, `XAG/INR`, and `XPT/INR` quotes using the `x-access-token` header. `RATE_REFRESH_INTERVAL_MS` controls metal polling (default 15 minutes, minimum 1 minute). USD/INR is fetched separately from `FX_DATA_URL`, which defaults to the open ExchangeRate-API USD feed; `FX_REFRESH_INTERVAL_MS` controls its polling (minimum 5 minutes). `DIAMOND_GUIDE_PRICE_INR` optionally sets a configured diamond guide price. GoldAPI does not provide a standardized diamond spot rate, so diamond values remain clearly labeled as guide rates. Without a configured GoldAPI key, metal values remain marked as demo/sample rates.

In production, use HTTPS, set a strong `JWT_SECRET` (at least 32 bytes), configure `TRUST_PROXY=true` only behind a trusted reverse proxy, and restrict access to the rate-update token. The included merchant API is an account/authentication foundation; merchant listings, verification, and trade inquiries still need server-side persistence before production use.

## Demo store data and admin panel

Set a separate `ADMIN_API_TOKEN` in `.env`, then seed the configured database explicitly:

```sh
npm run seed:stores
```

This inserts 100,000 labeled demo stores in batches of 2,000. To seed a smaller batch for testing, pass a count and batch size, for example `npm run seed:stores -- 1000 250`. The command appends records; rerunning it adds more demo stores. It never runs automatically at server startup. Demo rows have clearly fake shop and owner names, a sample location, and one or more commodity tags.

Sign in at `/admin` with `ADMIN_USERNAME` and the configured password. The dashboard uses an HttpOnly, SameSite=Strict, eight-hour session cookie; admin APIs also accept `Authorization: Bearer $ADMIN_API_TOKEN` for automation when configured. Store search uses SQLite FTS5; status, demo-record, and commodity filters use indexes, with cursor pagination capped at 100 rows per request. Add real stores as pending, approve or reject them after review, replace a demo row with real details (replacement remains pending), or delete demo rows. Real merchant records cannot be deleted through the demo cleanup action.
