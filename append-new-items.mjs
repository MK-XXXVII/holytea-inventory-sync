// append-new-items.mjs (ESM)
// Goal: Append missing Shopify inventory items into Truth_Table.

import { google } from "googleapis";

const CONFIG = {
  spreadsheetId: process.env.SPREADSHEET_ID,
  sheetName: process.env.SHEET_NAME || "Truth_Table",

  headers: {
    category: "Category",
    productTitle: "Product_Title",
    variantTitle: "Variant_Title",
    sku: "SKU",
    desired: "Desired_Available",
    available: "Available",
    status: "ReverseSync_Status",
    lastPushedAt: "ReverseSync_LastPushedAt",
    lastError: "ReverseSync_LastError",
    inventoryItemId: "InventoryItem_ID",
  },

  maxRowsPerRun: Number(process.env.MAX_ROWS_PER_RUN || "200"),

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

const GET_LOCATION_LEVELS = `
  query GetLocationLevels($locationId: ID!, $after: String) {
    location(id: $locationId) {
      id
      inventoryLevels(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            item { id }
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }
`;

const GET_INVENTORY_ITEM_DETAILS = `
  query InventoryItemDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        variant {
          sku
          title
          product {
            title
            productType
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

async function fetchInventoryItemDetails(ids) {
  const details = new Map(); // inventoryItemId -> { productType, productTitle, variantTitle, sku }
  const batchSize = 50;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const data = await shopifyGraphql(GET_INVENTORY_ITEM_DETAILS, { ids: batch });
    const nodes = data?.nodes || [];

    for (const node of nodes) {
      if (!node?.id) continue;
      const variant = node.variant || {};
      const product = variant.product || {};
      details.set(node.id, {
        productType: product.productType || "",
        productTitle: product.title || "",
        variantTitle: variant.title || "",
        sku: variant.sku || "",
      });
    }
  }

  return details;
}

function buildRowFromHeaders(headers, valuesByHeader) {
  return headers.map((header) => (header in valuesByHeader ? valuesByHeader[header] : ""));
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
  if (rows.length < 1) {
    console.log("No header row found.");
    return;
  }

  const headers = rows[0];
  const inventoryHeaderIndex = headers.indexOf(CONFIG.headers.inventoryItemId);
  if (inventoryHeaderIndex === -1) {
    throw new Error(`Missing header: ${CONFIG.headers.inventoryItemId}`);
  }

  const existingIds = new Set();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const value = row[inventoryHeaderIndex];
    if (value) existingIds.add(String(value).trim());
  }

  console.log(`Loaded ${existingIds.size} InventoryItem_ID values from sheet.`);
  console.log(`Building Shopify map for location ${CONFIG.locationId}...`);

  const availableMap = await buildLocationAvailableMap(CONFIG.locationId);
  console.log(`Shopify map ready. Items: ${availableMap.size}`);

  const missingIds = [];
  const newRows = [];
  for (const [inventoryItemId, available] of availableMap.entries()) {
    if (existingIds.has(inventoryItemId)) continue;

    missingIds.push(inventoryItemId);
    if (missingIds.length >= CONFIG.maxRowsPerRun) break;
  }

  if (missingIds.length === 0) {
    console.log("No new inventory items to append.");
    return;
  }

  const detailsMap = await fetchInventoryItemDetails(missingIds);

  for (const inventoryItemId of missingIds) {
    const available = availableMap.get(inventoryItemId);
    const details = detailsMap.get(inventoryItemId) || {};
    newRows.push(
      buildRowFromHeaders(headers, {
        [CONFIG.headers.inventoryItemId]: inventoryItemId,
        [CONFIG.headers.available]: available ?? "",
        [CONFIG.headers.desired]: "",
        [CONFIG.headers.status]: "",
        [CONFIG.headers.lastPushedAt]: "",
        [CONFIG.headers.lastError]: "",
        [CONFIG.headers.category]: details.productType || "",
        [CONFIG.headers.productTitle]: details.productTitle || "",
        [CONFIG.headers.variantTitle]: details.variantTitle || "",
        [CONFIG.headers.sku]: details.sku || "",
      })
    );

    if (newRows.length >= CONFIG.maxRowsPerRun) break;
  }

  console.log(`Appending ${newRows.length} new rows to ${CONFIG.sheetName}...`);

  await sheets.spreadsheets.values.append({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `${CONFIG.sheetName}!A:Z`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: newRows,
    },
  });

  console.log("Append complete.");
}

main().catch((err) => {
  console.error("Append failed:", err?.message || err);
  process.exitCode = 1;
});