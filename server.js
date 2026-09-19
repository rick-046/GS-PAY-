'use strict';

/**
 * TopUp – Deposit backend
 * -----------------------
 * Endpoints
 *   GET  /api/config                     -> tiers, payment methods, order lifetime
 *   POST /api/orders                     -> create an order  { tierId, amount, method }
 *   GET  /api/orders?ids=A,B,C           -> list orders by id (used by the Assets tab)
 *   GET  /api/orders/:orderId            -> single order (status polling)
 *   POST /api/orders/:orderId/utr        -> submit UTR       { utr }
 *   GET  /api/admin/orders               -> [admin] all orders
 *   POST /api/admin/orders/:id/status    -> [admin] { status: "verified" | "rejected" }
 *
 * Orders are persisted to ./data/orders.json so a restart does not lose them.
 * For real production traffic, swap this for a proper database (Postgres, MongoDB...).
 */

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ORDER_TTL_MS = 20 * 60 * 1000; // 20 minutes

// Who gets paid. Keep these in .env – never hard-code real bank details.
const PAYEE = {
  name: process.env.PAYEE_NAME || 'Your Business Name',
  vpa: process.env.PAYEE_VPA || 'yourbusiness@bank',
  account: process.env.PAYEE_ACCOUNT || '000000000000',
  ifsc: process.env.PAYEE_IFSC || 'ABCD0123456',
};

// Amount tiers. Edit freely – the frontend renders whatever is returned here.
const TIERS = [
  { id: 't1', min: 100, max: 199 },
  { id: 't2', min: 200, max: 499 },
  { id: 't3', min: 500, max: 999 },
  { id: 't4', min: 1000, max: 1999 },
  { id: 't5', min: 2000, max: 4999 },
  { id: 't6', min: 5000, max: 10000 },
];

const METHODS = [
  { id: 'paytm', label: 'Paytm' },
  { id: 'phonepe', label: 'PhonePe' },
  { id: 'upi', label: 'Any UPI app' },
];

const STATUSES = ['pending', 'submitted', 'verified', 'rejected', 'expired'];

/* ------------------------------------------------------------------ *
 * Tiny JSON-file "database"
 * ------------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'orders.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {Map<string, any>} */
const orders = new Map();

try {
  if (fs.existsSync(DB_FILE)) {
    JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).forEach((o) => orders.set(o.orderId, o));
  }
} catch (err) {
  console.error('Could not read orders.json, starting empty:', err.message);
}

function persist() {
  // Write to a temp file then rename so a crash never leaves a half-written file.
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...orders.values()], null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
const newOrderId = () =>
  'DP' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();

const ORDER_ID_RE = /^DP[A-Z0-9]{8,30}$/;
const UTR_RE = /^\d{12}$/; // UPI reference numbers are 12 digits

/** Lazily flips unpaid orders to "expired" once their timer runs out. */
function refreshStatus(order) {
  if (order.status === 'pending' && Date.now() > order.expiresAt) {
    order.status = 'expired';
    persist();
  }
  return order;
}

/** What the browser is allowed to see. */
function publicOrder(o) {
  return {
    orderId: o.orderId,
    tierId: o.tierId,
    amount: o.amount,
    method: o.method,
    status: o.status,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    utr: o.utr ? o.utr.slice(0, 4) + '••••' + o.utr.slice(-4) : null,
    payee: PAYEE,
    serverTime: Date.now(), // lets the client correct for a wrong device clock
  };
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin access is not configured.' });
  const key = req.get('x-admin-key') || '';
  if (!safeEqual(key, ADMIN_KEY)) return res.status(401).json({ error: 'Invalid admin key.' });
  next();
}

/* ------------------------------------------------------------------ *
 * App + middleware
 * ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: null, // keeps plain-http localhost testing working
      },
    },
  })
);
app.use(express.json({ limit: '10kb' }));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
const createLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
const utrLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */
app.get('/api/config', (req, res) => {
  res.json({ tiers: TIERS, methods: METHODS, ttlMinutes: ORDER_TTL_MS / 60_000 });
});

// Create an order. The server – not the browser – decides the amount is valid.
app.post('/api/orders', createLimiter, (req, res) => {
  const { tierId, method } = req.body || {};
  const amount = Number(req.body && req.body.amount);

  const tier = TIERS.find((t) => t.id === tierId);
  if (!tier) return res.status(400).json({ error: 'Choose a valid amount range.' });
  if (!METHODS.some((m) => m.id === method)) return res.status(400).json({ error: 'Choose a payment method.' });
  if (!Number.isInteger(amount) || amount < tier.min || amount > tier.max) {
    return res.status(400).json({ error: `Enter a whole amount between ₹${tier.min} and ₹${tier.max}.` });
  }

  const now = Date.now();
  const order = {
    orderId: newOrderId(),
    tierId,
    amount,
    method,
    status: 'pending',
    utr: null,
    createdAt: now,
    expiresAt: now + ORDER_TTL_MS,
  };
  orders.set(order.orderId, order);
  persist();
  res.status(201).json(publicOrder(order));
});

// List several orders (ids are unguessable, so knowing one is the "login").
app.get('/api/orders', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ORDER_ID_RE.test(s))
    .slice(0, 30);
  const list = ids
    .map((id) => orders.get(id))
    .filter(Boolean)
    .map(refreshStatus)
    .map(publicOrder)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ orders: list });
});

app.get('/api/orders/:orderId', (req, res) => {
  const order = ORDER_ID_RE.test(req.params.orderId) && orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found. Check the ID and try again.' });
  res.json(publicOrder(refreshStatus(order)));
});

// Submit the UTR / transaction reference after paying.
app.post('/api/orders/:orderId/utr', utrLimiter, (req, res) => {
  const order = ORDER_ID_RE.test(req.params.orderId) && orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  refreshStatus(order);

  if (order.status === 'expired') return res.status(409).json({ error: 'This order has expired. Start a new deposit.' });
  if (order.status !== 'pending') return res.status(409).json({ error: 'A UTR was already submitted for this order.' });

  const utr = String((req.body && req.body.utr) || '').trim();
  if (!UTR_RE.test(utr)) return res.status(400).json({ error: 'Enter the 12-digit UTR from your payment app.' });

  // The same UTR must never be able to claim two orders.
  for (const o of orders.values()) {
    if (o.utr === utr) return res.status(409).json({ error: 'This UTR has already been used.' });
  }

  order.utr = utr;
  order.status = 'submitted';
  order.submittedAt = Date.now();
  persist();
  res.json(publicOrder(order));
});

/* ------------------------------------------------------------------ *
 * Admin API (you check your bank statement, then verify or reject)
 * ------------------------------------------------------------------ */
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const list = [...orders.values()].map(refreshStatus).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ orders: list }); // includes the full UTR
});

app.post('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const status = req.body && req.body.status;
  if (!['verified', 'rejected'].includes(status) || !STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be "verified" or "rejected".' });
  }
  if (order.status !== 'submitted') {
    return res.status(409).json({ error: 'Only orders with a submitted UTR can be verified or rejected.' });
  }
  order.status = status;
  order.reviewedAt = Date.now();
  persist();
  res.json(order);
});

/* ------------------------------------------------------------------ *
 * Fallbacks
 * ------------------------------------------------------------------ */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

app.listen(PORT, () => {
  console.log(`TopUp running on http://localhost:${PORT}`);
  if (PAYEE.vpa === 'yourbusiness@bank') console.warn('⚠  PAYEE_* values are placeholders – set them in .env');
  if (!ADMIN_KEY) console.warn('⚠  ADMIN_KEY is not set – the admin endpoints are disabled');
});
