// reconcile-available.mjs (ESM)
// Goal: Refresh Truth_Table.Available from Shopify for the configured location.

import { google } from "googleapis";

const CONFIG = {
  spreadsheetId: process.env.SPREADSHEET_ID,
  sheetName: process.env.SHEET_NAME || "Truth_Table",

  // Columns (letters)
  col: {
    available: "F",
    inventoryItemId: "J",
    lastError: "I",
  },

  maxRowsPerRun: Number(process.env.MAX_ROWS_PER_RUN || "200"), // reconcile can do more
  shopDomain: process.env.SHOPIFY_STORE_DOMAIN,
  locationId: process.env.SHOPIFY_LOCATION_ID, // gid://shopify/Location/...
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function normalizeInt(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

async function shopifyGraphql(query, variables) {
  const shopDomain = requireEnv("SHOPIFY_STORE_DOMAIN");
  const token = requireEnv("SHOPIFY_ADMIN_TOKEN");
  const url = `https://${shopDomain}/admin/api/2025-10/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) throw new Error(`Shopify HTTP ${resp.status}: ${JSON.stringify(json).slice(0, 500)}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`);

  return json.data;
}

/**
 * Instead of inventoryItem.inventoryLevels(locationIds: ...),
 * we query the Location inventoryLevels and filter by inventoryItemId.
 * This avoids the unsupported argument error you hit.
 */
const GET_LOCATION_LEVELS = `
  query GetLocationLevels($locationId: ID!, $after: String) {
    location(id: $locationId) {
      id
      inventoryLevels(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            item { id }
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }
`;

async function buildLocationAvailableMap(locationId, maxPages = 10) {
  const map = new Map(); // inventoryItemId -> availableQuantity
  let after = null;

  for (let page = 0; page < maxPages; page++) {
    const data = await shopifyGraphql(GET_LOCATION_LEVELS, { locationId, after });
    const conn = data?.location?.inventoryLevels;
    const edges = conn?.edges || [];

    for (const e of edges) {
      const node = e?.node;
      const invItemId = node?.item?.id;
      const qty = node?.quantities?.find((x) => x.name === "available")?.quantity;
      if (invItemId && typeof qty === "number") map.set(invItemId, qty);
    }

    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  return map;
}

async function main() {
  requireEnv("SPREADSHEET_ID");
  requireEnv("SHOPIFY_STORE_DOMAIN");
  requireEnv("SHOPIFY_LOCATION_ID");
  requireEnv("SHOPIFY_ADMIN_TOKEN");

  const sheets = await getSheetsClient();

  const range = `${CONFIG.sheetName}!A:Z`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = res.data.values || [];
  if (rows.length < 2) {
    console.log("No data rows found.");
    return;
  }

  console.log(`Loaded ${rows.length - 1} rows from ${CONFIG.sheetName}.`);
  console.log(`Building available map from Shopify for location ${CONFIG.locationId}...`);

  const availableMap = await buildLocationAvailableMap(CONFIG.locationId);
  console.log(`Shopify map ready. Items: ${availableMap.size}`);

  const updates = [];
  let touched = 0;

  for (let i = 1; i < rows.length; i++) {
    if (touched >= CONFIG.maxRowsPerRun) break;

    const rowIndex1Based = i + 1;
    const row = rows[i];

    const invItemId = row[9] ? String(row[9]).trim() : null; // J
    if (!invItemId) continue;

    const sheetAvailable = normalizeInt(row[5]); // F
    const shopAvailable = availableMap.get(invItemId);

    // If Shopify doesn't have a level at this location, skip
    if (typeof shopAvailable !== "number") continue;

    if (sheetAvailable !== shopAvailable) {
      updates.push(
        { range: `${CONFIG.sheetName}!${CONFIG.col.available}${rowIndex1Based}`, values: [[shopAvailable]] },
        { range: `${CONFIG.sheetName}!${CONFIG.col.lastError}${rowIndex1Based}`, values: [[""]] }
      );
      touched++;
    }
  }

  console.log(`Rows needing Available refresh: ${touched}`);

  if (updates.length === 0) {
    console.log("Nothing to update.");
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: CONFIG.spreadsheetId,
    requestBody: { valueInputOption: "RAW", data: updates },
  });

  console.log("Reconcile done.");
}

main().catch((err) => {
  console.error("Reconcile failed:", err?.message || err);
  process.exitCode = 1;
});
