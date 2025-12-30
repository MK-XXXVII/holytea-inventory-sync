# Holy Tea — Shopify ↔ Google Sheets Inventory Sync (GCP)

This repo contains a production-grade inventory sync system for the live Shopify store **Holy Tea**:
- **Forward sync (Shopify → Pub/Sub → Google Sheets)** via Shopify `inventory_levels/update` webhook.
- **Reverse sync (Google Sheets → Shopify)** via a scheduled Cloud Run Job that detects changes in a sheet and updates Shopify inventory.

## High-level architecture

### Forward sync (already automated)
1. Shopify webhook topic: `inventory_levels/update`
2. Delivery: Pub/Sub URI  
   `pubsub://shopify-inventory-sync-482323:shopify-inventory-updates`
3. Pub/Sub subscription (worker): `shopify-inventory-updates-worker`
4. Cloud Run Job: `inventory-sync-job` (Node.js worker)
5. Updates Google Sheet tab `Truth_Table` column **Available** based on `InventoryItem_ID` matching.

### Reverse sync (automated)
1. Users edit `Truth_Table.Desired_Available`
2. Cloud Scheduler triggers Cloud Run Job: `inventory-reverse-sync-job` (Node.js worker)
3. Worker scans rows where `Desired_Available != Available`
4. Calls Shopify Admin GraphQL to set inventory at a specific location
5. On success:
   - clears `Desired_Available`
   - writes `ReverseSync_LastPushedAt`
   - clears `ReverseSync_LastError`
   - (optionally) clears `ReverseSync_Status`

## Google Cloud resources

### Project
- `shopify-inventory-sync-482323`

### Pub/Sub
- Topic: `shopify-inventory-updates`
- Subs:
  - `shopify-inventory-updates-debug` (manual inspect)
  - `shopify-inventory-updates-worker` (processed by forward job)

### Cloud Run Jobs
- Forward: `inventory-sync-job` (region `europe-west4`)
- Reverse: `inventory-reverse-sync-job` (region `europe-west4`)

### Cloud Scheduler
- Forward scheduler exists (region `europe-west1`)
- Reverse scheduler:
  - name: `inventory-reverse-sync-scheduler`
  - schedule: `*/2 * * * *`
  - URL (Cloud Run v2):  
    `https://europe-west4-run.googleapis.com/v2/projects/shopify-inventory-sync-482323/locations/europe-west4/jobs/inventory-reverse-sync-job:run`
  - Auth: OAuth token

### Service Accounts
- `pubsub-worker@shopify-inventory-sync-482323.iam.gserviceaccount.com`  
  Used by Cloud Run Jobs. Needs Sheets access + Secret access.
- `scheduler-runner@shopify-inventory-sync-482323.iam.gserviceaccount.com`  
  Used by Cloud Scheduler HTTP trigger. Needs Run Invoker.
- Cloud Scheduler service agent:  
  `service-615727392740@gcp-sa-cloudscheduler.iam.gserviceaccount.com`  
  Needs Service Account Token Creator on `scheduler-runner`.

## Google Sheets
- Spreadsheet ID: `15uWLUiduY0qQb6wbHIcUo-pqvp_ghTaO5ZnTP0gNZqg`
- Tab: `Truth_Table`
- Key columns:
  - `InventoryItem_ID` (Shopify GID format)
  - `Available` (forward sync writes here)
  - Reverse sync extension:
    - `Desired_Available`
    - `ReverseSync_Status`
    - `ReverseSync_LastPushedAt`
    - `ReverseSync_LastError`

## Secrets / configuration

### Shopify Admin Token
Stored in Secret Manager:
- Secret: `shopify-admin-token`
Injected into the reverse job as env var:
- `SHOPIFY_ADMIN_TOKEN`

### Reverse job env vars
- `SPREADSHEET_ID`
- `SHEET_NAME` (`Truth_Table`)
- `MAX_ROWS_PER_RUN` (e.g. 10)
- `SHOPIFY_STORE_DOMAIN` (`holy-tea-amsterdam.myshopify.com`)
- `SHOPIFY_LOCATION_ID` (`gid://shopify/Location/66678325498`)

## Local development notes
- Prefer Cloud Build + Cloud Run Jobs for runtime parity.
- Do **not** commit credentials (service account keys / tokens).
- Use Secret Manager for sensitive values.

## Deployment (Cloud Build)
Example:
```bash
gcloud builds submit --tag gcr.io/shopify-inventory-sync-482323/inventory-sync-worker:reverse-sync .