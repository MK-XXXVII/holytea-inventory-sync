# CONTEXT PROMPT FOR CODEX / AI ASSISTANT

You are assisting with a **production Google Cloud + Shopify inventory synchronization system**.

This is NOT a toy project.
Do NOT suggest rebuilding from scratch.
Respect existing architecture and constraints.

---

## Business Context

- Brand: Holy Tea Amsterdam
- Platform: Shopify (live store, custom app)
- Inventory managed via Google Sheets (human-friendly interface)

---

## Core Goals

1. Sync Shopify inventory → Google Sheets automatically
2. Allow humans to edit stock in Sheets
3. Push those changes back to Shopify safely
4. Avoid infinite loops
5. Handle stale inventory using CAS logic

---

## Existing Architecture (DO NOT BREAK)

### Forward Sync (Shopify → Sheets)
- Shopify webhook: `inventory_levels/update`
- Publishes to Google Pub/Sub
- Cloud Run Job processes messages
- Updates `Truth_Table.Available`

### Reverse Sync (Sheets → Shopify)
- Cloud Scheduler runs every X minutes
- Cloud Run Job:
  - Scans rows where Desired_Available ≠ Available
  - Uses Shopify GraphQL `inventorySetQuantities`
  - Uses compareQuantity for optimistic locking
  - Clears Desired_Available after success

### Reconcile Job
- One-off / manual Cloud Run Job
- Rebuilds `Available` from Shopify
- Used to eliminate stale quantity mismatches

---

## Google Sheets Schema (Truth_Table)

- Desired_Available → human input
- Available → last known Shopify quantity
- ReverseSync_Status → operational state
- ReverseSync_LastPushedAt → audit trail
- ReverseSync_LastError → debugging
- InventoryItem_ID → Shopify GID

---

## Implementation Rules (CRITICAL)

- NEVER remove compareQuantity
- NEVER assume Sheets is always correct
- Shopify is source of truth after push
- Retry inventory reads using:
  - `location(id) { inventoryLevels { item { id } quantities } }`
- Always support pagination
- Avoid undocumented GraphQL fields

---

## Allowed Improvements

- Performance optimizations
- Batch GraphQL calls
- Inventory map caching per run
- Observability (logs / metrics)
- Dry-run mode
- Sheet UX improvements
- Rate-limit handling

---

## Forbidden Changes

- Replacing Google Sheets with a database
- Removing Pub/Sub
- Removing CAS safety
- Using webhooks for reverse sync
- Writing to Shopify without reconciliation

---

## Current State

- Reverse sync fully working
- Scheduler-triggered
- Stale inventory handled
- Recovery job exists
- Repo contains Cloud Run workers

---

## When in Doubt

Ask before changing:
- Sheet schema
- Inventory semantics
- Shopify API usage
- Location handling

You are expected to **extend**, not rewrite.