# CASHVERSE v1

A simple browser-based **GCash and Maya cash-in/cash-out ledger** for Philippine sari-sari stores. English UI; responsive on phones, tablets, and computers.

**Repository:** [niviel-adt/cashverseph](https://github.com/niviel-adt/cashverseph)

## Features

- Owner password sign-in
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

First-time workflow: **Log in → Rates: upload CSV → Wallets: add initial floats using positive adjustments → New transaction.** Both floats start at ₱0 so no money is assumed to exist.

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

- One owner login, no cash drawer or actual bank/provider synchronization.
- Pending and Failed records do not affect float or daily earnings.
- Positive float adjustment adds funds; negative adjustment corrects/reduces float.
- Dashboard profit means **gross service fees only**; it does not subtract provider fees or other operating expenses.
- History UI shows latest 200 records; records remain in PostgreSQL.
- Next enhancements could include cash drawer balance, CSV exports, cashier accounts, audit reversals and backups.
