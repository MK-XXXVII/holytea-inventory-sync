import { v1 } from '@google-cloud/pubsub';
import { google } from 'googleapis';

const projectId = 'shopify-inventory-sync-482323';
const subscriptionName = 'shopify-inventory-updates-worker';

// 🔹 Google Sheet config
const spreadsheetId = '15uWLUiduY0qQb6wbHIcUo-pqvp_ghTaO5ZnTP0gNZqg';
const sheetName = 'Truth_Table';           // αν χρειαστεί αλλάζουμε αργότερα
const idColumnHeader = 'InventoryItem_ID'; // ακριβώς όπως το header στο sheet
const availableColumnHeader = 'Available'; // ακριβώς όπως το header στο sheet

const subClient = new v1.SubscriberClient();
const subscriptionPath = subClient.subscriptionPath(projectId, subscriptionName);

function columnIndexToA1(columnIndex) {
  // 0 -> A, 1 -> B, ...
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let n = columnIndex;
  let s = '';
  while (n >= 0) {
    s = alphabet[n % 26] + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function updateSheetForInventoryItem(inventoryItemId, available) {
  const sheets = await getSheetsClient();

  // 1️⃣ Φέρνουμε όλα τα rows από το Truth_Table
  const range = `${sheetName}!A:Z`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) {
    console.log('Sheet has no data.');
    return;
  }

  const headers = rows[0];
  const idColIndex = headers.indexOf(idColumnHeader);
  const availColIndex = headers.indexOf(availableColumnHeader);

  if (idColIndex === -1 || availColIndex === -1) {
    console.log(
      `Header(s) not found. Have headers: ${headers.join(', ')}`
    );
    return;
  }

  // 2️⃣ Βρίσκουμε τη γραμμή με το συγκεκριμένο InventoryItem_ID
  const gid = `gid://shopify/InventoryItem/${inventoryItemId}`;
  let targetRowIndex = -1;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[idColIndex] === gid) {
      targetRowIndex = i;
      break;
    }
  }

  if (targetRowIndex === -1) {
    console.log(`No row found in sheet for InventoryItem_ID = ${gid}`);
    return;
  }

  const rowNumber = targetRowIndex + 1; // 0-based → 1-based
  const columnLetter = columnIndexToA1(availColIndex);
  const targetRange = `${sheetName}!${columnLetter}${rowNumber}`;

  console.log(
    `Updating sheet row ${rowNumber}, cell ${targetRange} with available=${available}`
  );

  // 3️⃣ Κάνουμε update μόνο το κελί Available
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: targetRange,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[String(available)]],
    },
  });

  console.log('Sheet update OK for', gid);
}

async function main() {
  console.log('Starting inventory worker with Google Sheets sync...');

  const [response] = await subClient.pull({
    subscription: subscriptionPath,
    maxMessages: 10,
  });

  const receivedMessages = response.receivedMessages || [];

  if (receivedMessages.length === 0) {
    console.log('No messages received.');
    return;
  }

  for (const received of receivedMessages) {
    const msg = received.message;
    const ackId = received.ackId;

    const dataStr = msg?.data
      ? Buffer.from(msg.data, 'base64').toString('utf8')
      : null;

    console.log('RAW MESSAGE ID:', msg?.messageId);
    console.log('DATA:', dataStr);

    if (dataStr) {
      try {
        const payload = JSON.parse(dataStr);
        const inventoryItemId = payload.inventory_item_id;
        const available = payload.available;

        await updateSheetForInventoryItem(inventoryItemId, available);
      } catch (err) {
        console.error('Error parsing or updating sheet:', err);
      }
    }

    if (ackId) {
      await subClient.acknowledge({
        subscription: subscriptionPath,
        ackIds: [ackId],
      });
    }
  }

  console.log('Done processing batch.');
}

main().catch((err) => {
  console.error('Worker error:', err);
  process.exit(1);
});
