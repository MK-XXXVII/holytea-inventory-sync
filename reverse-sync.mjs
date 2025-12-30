// reverse-sync.mjs (ESM)
import { google } from "googleapis";

const CONFIG = {
  spreadsheetId: process.env.SPREADSHEET_ID,
  sheetName: process.env.SHEET_NAME || "Truth_Table",

  // Column letters (from you)
  col: {
    desired: "E",
    available: "F",
    status: "G",
    lastPushedAt: "H",
    lastError: "I",
    inventoryItemId: "J",
  },

  maxRowsPerRun: Number(process.env.MAX_ROWS_PER_RUN || "50"),

  shopDomain: process.env.SHOPIFY_STORE_DOMAIN, // holy-tea-amsterdam.myshopify.com
  locationId: process.env.SHOPIFY_LOCATION_ID,  // gid://shopify/Location/...
  token: process.env.SHOPIFY_ADMIN_TOKEN,        // injected from Secret Manager
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

function nowIso() {
  return new Date().toISOString();
}

async function shopifyInventorySetAvailable({ inventoryItemId, locationId, quantity, compareQuantity }) {
  const shopDomain = requireEnv("SHOPIFY_STORE_DOMAIN");
  const token = requireEnv("SHOPIFY_ADMIN_TOKEN");
  requireEnv("SHOPIFY_LOCATION_ID");

  const url = `https://${shopDomain}/admin/api/2025-10/graphql.json`;

  const query = `
    mutation InventorySet($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          createdAt
          reason
          changes { name delta quantityAfterChange }
        }
        userErrors { code field message }
      }
    }
  `;

  const variables = {
    input: {
      name: "available",
      reason: "correction",
      referenceDocumentUri: "holytea://reverse-sync/google-sheets",
      quantities: [
        {
          inventoryItemId,
          locationId,
          quantity,
          compareQuantity,
        },
      ],
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json();

  if (!resp.ok) {
    throw new Error(`Shopify HTTP ${resp.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  const topErrors = json.errors;
  if (topErrors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(topErrors).slice(0, 500)}`);
  }

  const payload = json.data?.inventorySetQuantities;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    // Common case: compareQuantity mismatch
    throw new Error(`Shopify userErrors: ${JSON.stringify(userErrors).slice(0, 500)}`);
  }

  return payload;
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

  const candidates = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const desired = normalizeInt(row[4]);      // E
    const available = normalizeInt(row[5]);    // F
    const invItemGid = row[9] ? String(row[9]).trim() : null; // J

    if (!invItemGid) continue;
    if (desired === null || available === null) continue;

    if (desired !== available) {
      candidates.push({
        rowIndex1Based: i + 1,
        inventoryItemId: invItemGid,
        desired,
        available,
      });
      if (candidates.length >= CONFIG.maxRowsPerRun) break;
    }
  }

  console.log(`Found ${candidates.length} candidate rows (Desired != Available).`);
  console.log(candidates.slice(0, 10));

  if (candidates.length === 0) return;

  // Mark PENDING first
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: CONFIG.spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: candidates.map((c) => ({
        range: `${CONFIG.sheetName}!${CONFIG.col.status}${c.rowIndex1Based}`,
        values: [["PENDING"]],
      })),
    },
  });

  // Process one-by-one (safe + clear logs)
  const updates = [];
  for (const c of candidates) {
    try {
      await shopifyInventorySetAvailable({
        inventoryItemId: c.inventoryItemId,
        locationId: CONFIG.locationId,
        quantity: c.desired,
        compareQuantity: c.available, // CAS safety
      });

      updates.push(
        { range: `${CONFIG.sheetName}!${CONFIG.col.status}${c.rowIndex1Based}`, values: [[""]] },
        { range: `${CONFIG.sheetName}!${CONFIG.col.lastPushedAt}${c.rowIndex1Based}`, values: [[nowIso()]] },
        { range: `${CONFIG.sheetName}!${CONFIG.col.lastError}${c.rowIndex1Based}`, values: [[""]] },
        { range: `${CONFIG.sheetName}!${CONFIG.col.desired}${c.rowIndex1Based}`, values: [[""]] }, // clear Desired_Available
      );

      console.log(`SYNCED row ${c.rowIndex1Based}: ${c.inventoryItemId} ${c.available} -> ${c.desired}`);
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 450);

      updates.push(
        { range: `${CONFIG.sheetName}!${CONFIG.col.status}${c.rowIndex1Based}`, values: [["ERROR"]] },
        { range: `${CONFIG.sheetName}!${CONFIG.col.lastError}${c.rowIndex1Based}`, values: [[msg]] },
      );

      console.error(`ERROR row ${c.rowIndex1Based}: ${msg}`);
    }
  }

  // Write back statuses/errors in one batch
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: CONFIG.spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: updates,
    },
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error("Reverse sync job failed:", err?.message || err);
  process.exitCode = 1;
});
