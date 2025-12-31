// update-product-metadata.mjs (ESM)
// Goal: Update Category/Product_Title/Variant_Title/SKU columns for existing rows.

import { google } from "googleapis";

const CONFIG = {
  spreadsheetId: process.env.SPREADSHEET_ID,
  sheetName: process.env.SHEET_NAME || "Truth_Table",

  headers: {
    category: "Category",
    productTitle: "Product_Title",
    variantTitle: "Variant_Title",
    sku: "SKU",
    inventoryItemId: "InventoryItem_ID",
  },

  maxRowsPerRun: Number(process.env.MAX_ROWS_PER_RUN || "500"),

  shopDomain: process.env.SHOPIFY_STORE_DOMAIN,
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

async function fetchInventoryItemDetails(ids) {
  const details = new Map();
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

function columnLetter(index) {
  let result = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function shouldUpdateValue(currentValue, nextValue) {
  if (!nextValue) return false;
  return String(currentValue ?? "") !== String(nextValue);
}

async function main() {
  requireEnv("SPREADSHEET_ID");
  requireEnv("SHOPIFY_STORE_DOMAIN");
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
  const categoryIndex = headers.indexOf(CONFIG.headers.category);
  const productTitleIndex = headers.indexOf(CONFIG.headers.productTitle);
  const variantTitleIndex = headers.indexOf(CONFIG.headers.variantTitle);
  const skuIndex = headers.indexOf(CONFIG.headers.sku);

  if (inventoryHeaderIndex === -1) {
    throw new Error(`Missing header: ${CONFIG.headers.inventoryItemId}`);
  }
  if ([categoryIndex, productTitleIndex, variantTitleIndex, skuIndex].some((index) => index === -1)) {
    throw new Error("Missing one or more metadata headers (Category/Product_Title/Variant_Title/SKU).");
  }

  const rowData = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const inventoryItemId = row[inventoryHeaderIndex];
    if (!inventoryItemId) continue;
    rowData.push({
      rowIndex: i + 1,
      inventoryItemId: String(inventoryItemId).trim(),
      current: {
        category: row[categoryIndex] ?? "",
        productTitle: row[productTitleIndex] ?? "",
        variantTitle: row[variantTitleIndex] ?? "",
        sku: row[skuIndex] ?? "",
      },
    });
  }

  if (rowData.length === 0) {
    console.log("No inventory items found in sheet.");
    return;
  }

  const detailsMap = await fetchInventoryItemDetails(rowData.map((row) => row.inventoryItemId));
  const updates = [];
  let updatedRows = 0;

  for (const row of rowData) {
    if (updatedRows >= CONFIG.maxRowsPerRun) break;
    const details = detailsMap.get(row.inventoryItemId);
    if (!details) continue;

    const changes = [
      {
        headerIndex: categoryIndex,
        value: details.productType,
        current: row.current.category,
      },
      {
        headerIndex: productTitleIndex,
        value: details.productTitle,
        current: row.current.productTitle,
      },
      {
        headerIndex: variantTitleIndex,
        value: details.variantTitle,
        current: row.current.variantTitle,
      },
      {
        headerIndex: skuIndex,
        value: details.sku,
        current: row.current.sku,
      },
    ];

    let hasUpdate = false;
    for (const change of changes) {
      if (shouldUpdateValue(change.current, change.value)) {
        const col = columnLetter(change.headerIndex);
        updates.push({
          range: `${CONFIG.sheetName}!${col}${row.rowIndex}`,
          values: [[change.value]],
        });
        hasUpdate = true;
      }
    }

    if (hasUpdate) updatedRows += 1;
  }

  if (updates.length === 0) {
    console.log("No metadata updates required.");
    return;
  }

  console.log(`Updating metadata for ${updatedRows} rows...`);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: CONFIG.spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: updates,
    },
  });

  console.log("Metadata update complete.");
}

main().catch((err) => {
  console.error("Metadata update failed:", err?.message || err);
  process.exitCode = 1;
});
