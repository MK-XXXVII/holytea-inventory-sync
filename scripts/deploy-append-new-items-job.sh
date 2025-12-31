#!/usr/bin/env bash
set -euo pipefail

JOB_NAME=${JOB_NAME:-inventory-append-new-items-job}
REGION=${REGION:-europe-west4}
PROJECT_ID=${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}
IMAGE=${IMAGE:-gcr.io/${PROJECT_ID}/inventory-sync-worker:append-new-items}

if [[ -z "${PROJECT_ID}" ]]; then
  echo "PROJECT_ID is not set and no gcloud default project found." >&2
  exit 1
fi

if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Updating existing Cloud Run job ${JOB_NAME} in ${REGION}..."
  gcloud run jobs update "${JOB_NAME}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --image "${IMAGE}"
else
  echo "Creating Cloud Run job ${JOB_NAME} in ${REGION}..."
  gcloud run jobs create "${JOB_NAME}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --image "${IMAGE}"
fi
