# CASHVERSE v1.2

A simple browser-based **GCash and Maya cash-in/cash-out ledger** for Philippine sari-sari stores. English UI; responsive on phones, tablets, and computers.

**Repository:** [niviel-adt/cashverseph](https://github.com/niviel-adt/cashverseph)

## Features

- Owner/manager password sign-in plus manager-created cashier logins
- Separate GCash and Maya electronic wallet float balances
- Cash-in and cash-out transaction entry
- **CSV-uploaded service fees** by wallet, transaction type, exact amount or amount range
- Add fee on top or deduct fee from the requested amount, selected for each transaction
- Save Pending without changing float; mark Completed only after verifying in the official wallet app
- Auto-update float for completed transactions; cash-in decreases e-wallet float, cash-out increases it
- Transaction history with status and recorded fee
- Daily service-fee earnings summary using **Asia/Manila** dates
- Manual float adjustments with reasons and adjustment history
- PostgreSQL for persistent transactions and sessions
- Dedicated cashier-only mobile transaction screen
- Server-enforced permissions: cashiers can quote and record transactions only
- Manager can create, disable, reactivate, and reset cashier accounts
- Every transaction records the cashier/manager responsible
- Optional manager approval before cashier records affect wallet float
- Manager overview and history refresh automatically every 15 seconds while visible

CASHVERSE **does not connect to, withdraw from, transfer to, or process money inside GCash or Maya.** This app records transactions that a cashier performs in the *official provider app*. Never enter customer wallet PINs or OTPs here.

## How the fee options work

For a requested amount of ₱500 with a ₱10 fee:

| Service | Fee mode | Wallet transfer | Customer's cash |
| --- | --- | --- | --- |
| Cash-in | Add | Store sends ₱500 to customer | Customer pays ₱510 |
| Cash-in | Deduct | Store sends ₱490 to customer | Customer pays ₱500 |
| Cash-out | Deduct | Customer sends ₱500 to store | Customer receives ₱490 |
| Cash-out | Add | Customer sends ₱510 to store | Customer receives ₱500 |

Fees are stored **with each transaction at recording time**. Later CSV uploads do not modify historical fees. Service fees are store-configured charges, not official provider fees.

## Upload service rates

Go to **Rates → Download sample CSV → Edit in Excel / Google Sheets → Save as CSV → Upload**.

Required columns:

```csv
provider,transaction_type,min_amount,max_amount,fee
GCASH,CASH_IN,1,500,10
GCASH,CASH_IN,500.01,1000,20
GCASH,CASH_OUT,1,500,10
GCASH,CASH_OUT,500.01,1000,20
MAYA,CASH_IN,1,500,10
MAYA,CASH_OUT,1,500,10
```

- Provider values: `GCASH`, `MAYA`. Transaction types: `CASH_IN`, `CASH_OUT`.
- Amounts and fees are Philippine pesos with up to 2 decimals.
- For an **exact amount**, set `min_amount` and `max_amount` equal (e.g. `500,500`); exact amounts take precedence over ranges.
- Overlapping ranges for the same provider and transaction type are rejected.
- **Every upload replaces the entire active rate table.** Include all rules that you want to keep.
- Transactions without a matching rate cannot be created; upload rate rules first.
- CSV is capped at 500 rate rows and 100 KB.
- The example fees are *illustrative*, not official provider rates. Follow any applicable service/agent agreements.

## Run locally

Requires Node.js 20+, PostgreSQL, and npm.

```bash
git clone https://github.com/niviel-adt/cashverseph.git
cd cashverseph
npm install
cp .env.example .env
```

Create an empty PostgreSQL database named `cashverse` (or update `DATABASE_URL`). Edit `.env` with its connection string and strong owner password and session secret. Never commit your `.env` file.

```bash
npm run dev
```

Open http://localhost:3000. The database tables are created automatically on first startup.

First-time manager workflow: **Log in with username `owner` and the existing owner password → Rates: upload CSV → Wallets: add initial floats using positive adjustments → Cashiers: create cashier accounts → New transaction.** Both floats start at ₱0 so no money is assumed to exist.

## Railway deployment

This source is designed for **GitHub → Railway**. In the existing Railway **CASHVERSE** project, connect the `cashverse-web` service to `niviel-adt/cashverseph` and point it to `main`. A Postgres service has already been provisioned for this project.

Set these variables on the **web** service:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway service reference) |
| `NODE_ENV` | `production` |
| `OWNER_PASSWORD` | Your own unique 12+ character password |
| `SESSION_SECRET` | A freshly generated random secret of 32+ characters |

Railway injects `PORT` automatically. The start command is `npm start`. After deployment, generate a Railway domain and test `/health` and the login page. **Do not commit credentials to GitHub.** Set up regular database backups before business-critical use.

## Running checks

```bash
npm run check
npm test
```

## V1 notes

- One manager login plus multiple cashier logins; no cash drawer or actual bank/provider synchronization.
- Pending and Failed records do not affect float or daily earnings.
- Positive float adjustment adds funds; negative adjustment corrects/reduces float.
- Dashboard profit means **gross service fees only**; it does not subtract provider fees or other operating expenses.
- History UI shows latest 200 records; records remain in PostgreSQL.
- Next enhancements could include a cash drawer ledger, CSV exports, audit reversals, and backups.

## V1.1: manager and cashier accounts

**Same website for everyone:** https://cashverse-web-production.up.railway.app

### Manager
1. Sign in with username `owner` and the existing `OWNER_PASSWORD` set in Railway.
2. Click **Cashiers**.
3. Create a cashier with a display name, username, and unique password (minimum 10 characters).
4. Give their login details privately to the cashier.
5. Disable, reactivate, or reset each cashier account from the Cashiers page.
6. Optionally enable **Require manager approval**. This applies to newly recorded cashier transactions after you save the setting.

### Cashier
1. Sign in to the **same** CASHVERSE URL with the cashier username and password.
2. The application immediately shows a single mobile-friendly **New Transaction** screen. The manager navigation is hidden.
3. Choose GCash/Maya and Cash-in/Cash-out, enter the amount (or tap a quick amount), and choose Add/Deduct fee.
4. Verify the actual transfer in the official provider wallet app. Check the verification box if confirmed, then save.
5. When manager approval is **off**, a verified cashier transaction completes immediately and updates the shared wallet float. Unverified transactions stay Pending.
6. When manager approval is **on**, *all* cashier transactions stay Pending without updating float until the manager confirms and completes them from **History**.
7. Cashiers cannot view account balances, daily earnings, transaction history, wallet adjustments, fee uploads, cashier management, or settings. These restrictions are enforced by the server.

The manager's overview and history automatically refresh approximately every **15 seconds** while that page is open. This is polling, not a direct GCash/Maya integration or instantaneous real-time push. Cashier attribution and the applied fee are preserved in the transaction record, even if the cashier account is later disabled.

## Security and financial-record notes

- Cashier passwords are stored as salted scrypt hashes, not plaintext. Do not share owner credentials with cashiers.
- Managers should use a unique strong owner password. A password is never shown again after creating or resetting a cashier account.
- The manager must independently confirm any pending transaction before completing it.
- A deleted or disabled cashier session cannot continue using protected APIs.
- Never collect wallet OTPs, PINs, or customer wallet passwords.
- For production financial use, set up **regular PostgreSQL backups**, validate agent fee policies, and verify transaction references in official provider apps.
- Historical v1 transaction and wallet data are preserved by additive database migrations.

## Preparing the live store for launch

A manager-only **Launch setup** page allows you to create a clean store baseline.

1. Log in as the owner and open **Launch setup**.
2. Review the current record counts and recorded GCash/Maya float balances.
3. Choose **Download pre-launch records**. Keep the downloaded JSON file private; it can contain transaction references or customer-related notes.
4. Check the download exists in your device's Downloads folder.
5. Type `RESET CASHVERSE`, enter your current owner password, acknowledge the backup and approve the final confirmation.
6. The app snapshots the previous transactions, adjustments, pending cashier request IDs and wallet balances in an internal `launch_archives` table.
7. It clears the transaction and adjustment tables, clears pending cashier request records, and sets **GCash and Maya floats to ₱0.00**.
8. **Cashier accounts, owner credentials, uploaded service rate tables and manager approval settings are retained.**
9. Manually enter your actual opening balances under **Wallets** and verify the configured rates.

The reset is **not automatic** on deploy, and launching or restarting Railway does not clear business data. This action must be explicitly submitted by an authenticated manager with a current owner password. It is intended for **test data only**; do not delete real customer records without evaluating your retention obligations. The downloaded JSON is a record export, **not a restorable PostgreSQL database backup**. Set up separate database backups before live transactions. The internal PostgreSQL archive is protected by the same database, and therefore is not disaster-proof. An archive can be downloaded later using `GET /api/launch/archives/{archiveId}` while logged in as manager.

Because a reset affects current business data, verify other staff are not actively recording transactions while it runs. The reset uses a PostgreSQL transaction and exclusive locks so incomplete cleanup is rolled back.

**Security:** Prefer a long, unique owner password instead of a six-digit PIN for an internet-accessible application.


## V1.2 QR customer orders

**Customer page:** \`https://cashverse-web-production.up.railway.app/order.html\`

V1.2 adds three customer journeys on **one public webpage**: cash-in with receiving QR upload, walk-in cash-out, and cash-out reservation with a chosen pickup time. A public QR-code SVG for printing is available at \`/api/public/orders/qr.svg\`. The customer receives an unpredictable order tracking link and an order number. No customer login is required. Customer orders are **disabled by default** until the manager prepares the cash drawer, reviews uploaded rate rules and explicitly enables the feature.

### Owner and manager setup
1. Open CASHVERSE as **owner → QR orders**.
2. Set your actual opening cash drawer amount, with a reason. From this point onward completed manual and QR transactions update the same drawer automatically.
3. Review uploaded GCash/Maya fee rates and configure a maximum cash-out order amount (default ₱20,000; hard limit ₱50,000).
4. Optionally upload your store's **authorized** receiving QR per wallet. Only logged-in staff can view this uploaded QR. It is not displayed automatically to unverified online customers.
5. Download or print the store customer-order QR; display it at the counter or share the customer request URL.
6. Enable **Accept new customer QR orders** only when the store is ready. Disabling the switch prevents **new** submissions but does not change existing orders.

### Cash-in requests
Customers choose a wallet, amount, fee method, and upload their own receiving QR screenshot. The cashier starts the order, collects cash and uses the provider's official app to transfer to the verified recipient. Only after confirming the transaction reference and the physical cash does the order complete. GCash/Maya float decreases, the physical drawer increases, and a completed transaction with fees appears in the existing ledger.

### Walk-in cash-out
The customer requests an amount and receives an order number; no customer payment is automatically collected. The cashier finds the order, checks the order code, follows an authorized official-provider procedure to receive and verify funds, and releases physical cash when authorized. On completion the wallet ledger increases and the cash drawer decreases. A screenshot or customer-provided reference alone is not proof of payment.

### Advance cash-out pickup
Customer chooses a pickup date/time (Philippine time, 30 minutes to 7 days ahead). **No advance payment is requested**. The manager must accept the reservation, atomically verifying enough unreserved physical cash and holding the payout amount. Staff verifies the order code when the customer arrives, checks the official incoming wallet transfer, then releases cash. Reservations expire one hour after their pickup time if unclaimed. Expired/rejected reservations release the hold; they do not affect wallet float or the cash balance.

### Approval and permissions
Cashier accounts get a mobile **QR orders** tab plus **New transaction**. They can claim walk-in and accepted pickup orders, view receiving QR screenshots, verify the official transfer and submit a completion. If the existing cashier manager-approval setting is on, their verification moves orders to **Awaiting manager approval** and **does not update wallet or cash** until the manager independently confirms. Manager-only actions include accepting pickup reservations, changing cash drawer/rate/owner settings, and approving pending transactions.

### Notifications, safety, and scope
- The staff order queue and badge refresh approximately every 8 seconds while the app is open and visible; optional sound can be enabled with a user gesture. **OS/browser push notifications while the app is closed are not included**.
- Customer QR screenshots are stored as private PostgreSQL image bytes, not public files. Only authenticated staff may view them. Uploads are resized in-browser and capped at 600 KB after encoding; only PNG/JPG/WebP signatures are permitted.
- QR images are deleted from completed/rejected/expired orders after 14 days; active, long-stale uploads are eventually purged.
- Public requests are rate-limited, and order submissions have unique request IDs; completed QR transfers cannot reuse a previously completed wallet reference.
- CASHVERSE is not a payment gateway, does not confirm actual GCash/Maya wallet transfers automatically, and must never collect wallet PINs, OTPs or passwords.
- The **Launch setup** manager screen now exports and archives order metadata and cash drawer movement records, clears old QR requests, disables new public requests, and resets the cash drawer while preserving manager/cashier accounts and rate tables. Customer-uploaded QR images are omitted from exported archives for privacy.

The application should be pilot-tested with small, manually verified transactions before relying on the cash drawer ledger for operations. A JSON export is **not a database backup**; arrange independent Railway/PostgreSQL backups and review your provider's authorization requirements.
