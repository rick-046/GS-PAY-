'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

// Static files (HTML, CSS, JS) serve karne ke liye
app.use(express.static(__dirname));

// Main Route - index.html kholne ke liye
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Config API
app.get('/api/config', (req, res) => {
  res.json({
    payeeName: process.env.PAYEE_NAME || 'Merchant',
    upiId: process.env.UPI_ID || 'merchant@upi'
  });
});

let orders = [];

// Orders API
app.post('/api/orders', (req, res) => {
  const { amount } = req.body;
  const newOrder = {
    id: 'ORD' + Date.now(),
    amount,
    status: 'PENDING',
    utr: null,
    createdAt: new Date()
  };
  orders.push(newOrder);
  res.json({ success: true, order: newOrder });
});

app.post('/api/orders/:orderId/utr', (req, res) => {
  const { orderId } = req.params;
  const { utr } = req.body;
  const order = orders.find(o => o.id === orderId);
  if (order) {
    order.utr = utr;
    order.status = 'VERIFYING';
    return res.json({ success: true, order });
  }
  res.status(404).json({ success: false, message: 'Order not found' });
});

// Admin Panel Orders
app.get('/api/admin/orders', (req, res) => {
  res.json(orders);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
