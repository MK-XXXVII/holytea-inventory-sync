# Holy Tea – Shopify ↔ Google Sheets Inventory Sync

This repository contains the production-grade infrastructure and workers used by **Holy Tea Amsterdam** to synchronize inventory data between **Shopify** and **Google Sheets**, in both directions.

The system is designed to be:
- Safe (no infinite loops)
- Auditable (Google Sheets as source of truth & log)
- Extensible (Cloud Run Jobs, modular Node.js workers)
- Production-ready (Secrets Manager, IAM, Scheduler, retries)

---

## High-Level Architecture

### Shopify → Google Sheets (Forward Sync)
```
Shopify Inventory Change
        ↓
Shopify Webhook (inventory_levels/update)
        ↓
Google Pub/Sub Topic
        ↓
Cloud Run Job (inventory-sync-job)
        ↓
Google Sheets (Truth_Table → Available)
```

### Google Sheets → Shopify (Reverse Sync)
```
Google Sheets (Desired_Available edited)
        ↓
Cloud Scheduler (every X minutes)
        ↓
Cloud Run Job (inventory-reverse-sync-job)
        ↓
Shopify Admin GraphQL API
        ↓
Shopify Inventory Updated
        ↓
Shopify Webhook fires again
        ↓
Forward sync updates Sheet → Available
```

### One-time / Recovery Tool
```
Cloud Run Job (inventory-reconcile-available-job)
→ Rebuilds Sheet.Available from Shopify
→ Fixes stale / mismatched quantities
```

---

## Google Sheets Schema (Truth_Table)

| Column | Name | Purpose |
|------:|------|---------|
| A | Category | Shopify productType (metadata sync) |
| B | Product_Title | Shopify product title (metadata sync) |
| C | Variant_Title | Shopify variant title (metadata sync) |
| D | SKU | Shopify SKU (metadata sync) |
| E | Desired_Available | User input – desired stock to push to Shopify |
| F | Available | Last known Shopify quantity |
| G | ReverseSync_Status | PENDING, ERROR, or empty |
| H | ReverseSync_LastPushedAt | ISO timestamp of last successful push |
| I | ReverseSync_LastError | Error message if sync failed |
| J | InventoryItem_ID | Shopify GID (gid://shopify/InventoryItem/...) |

> Desired_Available is **cleared automatically** after a successful sync.

---

## Cloud Run Jobs

### inventory-sync-job
- Direction: Shopify → Sheets
- Trigger: Cloud Scheduler
- Input: Pub/Sub webhook events
- Output: Updates `Available`

### inventory-reverse-sync-job
- Direction: Sheets → Shopify
- Trigger: Cloud Scheduler
- Logic:
  - Finds rows where Desired_Available ≠ Available
  - Uses CAS (`compareQuantity`) for safety
  - Retries using live Shopify inventory if stale
  - Clears Desired_Available after success

### inventory-reconcile-available-job
- Purpose: Recovery / consistency
- Rebuilds `Available` from Shopify for all rows
- Use when stale quantity errors appear

### inventory-append-new-items-job
- Purpose: Append new Shopify inventory items into `Truth_Table`
- Trigger: Cloud Scheduler or manual
- Output:
  - Appends rows that are missing `InventoryItem_ID`
  - Populates `Available` and metadata columns when headers exist

### inventory-update-product-metadata-job
- Purpose: Maintain metadata columns (Category/Product_Title/Variant_Title/SKU)
- Trigger: Cloud Scheduler or manual
- Output:
  - Updates metadata when Shopify values are non-empty and different
  - Fills empty metadata cells
  - Does not alter inventory quantities

---

## Shopify API Usage

- API: Admin GraphQL (2025-10)
- Mutation: inventorySetQuantities
- Safety: compareQuantity (optimistic locking)
- Retry source:
  ```
  location(id) → inventoryLevels → item.id → available
  ```

---

## Secrets & Security

- Shopify Admin token stored in Google Secret Manager
  - Secret: `shopify-admin-token`
- Injected via Cloud Run Job config
- No secrets stored in code or repository

---

## Metadata Sync (Category/Product_Title/Variant_Title/SKU)

- Source fields come from Shopify `InventoryItem → Variant → Product`
- `Category` maps to Shopify `productType`
- Jobs support excluding certain product types via:
  - `EXCLUDE_PRODUCTTYPE_KEYWORDS` (comma-separated, default: `bundle,subscription,box`)
  - Example: `EXCLUDE_PRODUCTTYPE_KEYWORDS=bundle,subscription,box,kit`

---

## Deployment

Build image:
```bash
gcloud builds submit \
  --tag gcr.io/shopify-inventory-sync-482323/inventory-sync-worker:reverse-sync .
```

Update job:
```bash
gcloud run jobs update inventory-reverse-sync-job \
  --region=europe-west4 \
  --image=gcr.io/shopify-inventory-sync-482323/inventory-sync-worker:reverse-sync
```

Update append job:
```bash
gcloud run jobs update inventory-append-new-items-job \
  --region=europe-west4 \
  --image=gcr.io/shopify-inventory-sync-482323/inventory-sync-worker:append-new-items \
  --command=node \
  --args=append-new-items.mjs
```

Update metadata job:
```bash
gcloud run jobs update inventory-update-product-metadata-job \
  --region=europe-west4 \
  --image=gcr.io/shopify-inventory-sync-482323/inventory-sync-worker:update-product-metadata \
  --command=node \
  --args=update-product-metadata.mjs
```

---

## Operational Notes

- Google Sheets is not real-time
- System is eventually consistent by design
- Forward sync always wins after reverse sync
- All writes are idempotent and retry-safe

---

## Status

✅ Production ready
✅ Reverse sync enabled
✅ Scheduler-driven
✅ Safe against infinite loops

Maintained by **Holy Tea Amsterdam**.
