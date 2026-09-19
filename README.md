# TopUp – Deposit & UPI Recharge Web App

Mobile-first deposit flow: **Deposit tiers → Buy → payment-method dialog → Transaction information (20-min timer) → Go to Transfer (UPI deep link) → Submit UTR → status updates.**

Stack: Node.js + Express backend, vanilla HTML/CSS/JS frontend (no build step).

## Run locally

```bash
cd deposit-app
npm install
cp .env.example .env      # then edit PAYEE_* and ADMIN_KEY
npm start                 # http://localhost:3000
```

Open it on your phone (same Wi-Fi) using your computer's LAN IP to test the UPI deep link – UPI apps only open on phones.

## Project layout

```
server.js            API, validation, order storage, admin endpoints
data/orders.json     created automatically (order storage)
public/index.html    markup: tabs, dialog, transaction page
public/styles.css    mobile-first styles
public/app.js        UI logic, timer, UPI link, UTR submit
```

## Customising

| What                | Where                                             |
| ------------------- | ------------------------------------------------- |
| Amount tiers        | `TIERS` array in `server.js`                      |
| Payment methods     | `METHODS` in `server.js` + radios in `index.html` |
| Order lifetime      | `ORDER_TTL_MS` in `server.js` (default 20 min)    |
| Payee details       | `PAYEE_*` in `.env`                               |
| UPI app link schemes| `UPI_SCHEMES` in `public/app.js`                  |

## How verification works

The app cannot know that money arrived – a UTR typed by a user is only a claim. Orders move through:

`pending → submitted (UTR entered) → verified | rejected`, or `expired` if unpaid after 20 minutes.

You confirm each payment against your bank statement using the admin API:

```bash
# list orders (full UTRs included)
curl -H "x-admin-key: $ADMIN_KEY" http://localhost:3000/api/admin/orders

# mark one as verified (or "rejected")
curl -X POST http://localhost:3000/api/admin/orders/DPXXXXXXXX/status \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"status":"verified"}'
```

The customer's page polls every 8 seconds and updates on its own.

## Deploy

- **Render / Railway / Fly.io:** create a Node web service, start command `npm start`, add the `.env` values as environment variables, and set `TRUST_PROXY=1`.
- **VPS:** `npm ci --omit=dev`, run with `pm2 start server.js`, put Nginx + HTTPS in front.
- Use a persistent disk/volume for `data/`, or replace the JSON file with a real database.

## Before real money goes through this

1. **Use a licensed payment gateway for production.** Razorpay, Cashfree, PhonePe PG, Paytm PG and similar give you automatic payment confirmation and webhooks, so you don't rely on hand-checked UTRs. Collecting customer money into an ordinary personal or current account through a checkout like this can also run against NPCI/RBI merchant rules and your bank's terms.
2. **Add user accounts.** Orders here are tied to the device (order IDs in `localStorage`). Add login (phone OTP, email) before crediting any balance.
3. **Add an admin UI and audit log** rather than raw `curl`.
4. **Move to a database** (Postgres/MongoDB) and add backups.
5. **Check the legal and tax obligations** for what you're selling (KYC, GST, terms of service, refund policy).
