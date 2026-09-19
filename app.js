/* ==========================================================================
   TopUp – frontend logic (vanilla JS, no build step)

   Flow:  Deposit tab → Buy → payment-method dialog → Confirm
          → Transaction information page (order ID, 20-min timer, payee, amount)
          → Go to Transfer (UPI deep link) → Submit UTR → status updates
   ========================================================================== */
(() => {
  'use strict';

  /* ---------- Tiny helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');

  const STORE_KEY = 'topup.orderIds.v1';
  const ORDER_ID_RE = /^DP[A-Z0-9]{8,30}$/;
  const UTR_RE = /^\d{12}$/;

  const METHOD_LABEL = { paytm: 'Paytm', phonepe: 'PhonePe', upi: 'UPI' };
  const STATUS_LABEL = {
    pending: 'Awaiting payment',
    submitted: 'Under review',
    verified: 'Verified',
    rejected: 'Rejected',
    expired: 'Expired',
  };

  /**
   * UPI deep-link schemes. "upi://pay" lets Android show its app chooser;
   * the app-specific schemes jump straight to that app.
   */
  const UPI_SCHEMES = {
    upi: 'upi://pay',
    phonepe: 'phonepe://pay',
    paytm: 'paytmmp://pay',
  };

  const state = {
    tiers: [],
    activeTier: null,
    order: null,
    skew: 0, // server clock minus device clock, so the timer stays honest
    timerId: null,
    pollId: null,
    currentTab: 'home',
    returnTab: 'deposit',
  };

  /* ---------- Element references ---------- */
  const el = {
    title: $('#topbarTitle'),
    tierList: $('#tierList'),
    orderView: $('#orderView'),
    orderList: $('#orderList'),
    ordersEmpty: $('#ordersEmpty'),
    payDialog: $('#payDialog'),
    payForm: $('#payForm'),
    amountInput: $('#amountInput'),
    amountHint: $('#amountHint'),
    payError: $('#payError'),
    payConfirm: $('#payConfirm'),
    ticket: $('#ticket'),
    ordAmount: $('#ordAmount'),
    ordId: $('#ordId'),
    ordStatus: $('#ordStatus'),
    ordTimer: $('#ordTimer'),
    timerLabel: $('#timerLabel'),
    payeeRows: $('#payeeRows'),
    goBtn: $('#goBtn'),
    goHint: $('#goHint'),
    utrForm: $('#utrForm'),
    utrInput: $('#utrInput'),
    utrBtn: $('#utrBtn'),
    utrError: $('#utrError'),
    utrDone: $('#utrDone'),
    toast: $('#toast'),
  };

  /* ---------- Storage (order IDs remembered on this device) ---------- */
  function readIds() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
    } catch {
      return [];
    }
  }
  function saveId(id) {
    const ids = [id, ...readIds().filter((x) => x !== id)].slice(0, 30);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(ids));
    } catch {
      /* private mode – the order still works, it just won't be listed later */
    }
  }

  /* ---------- API ---------- */
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(message, kind = 'info', ms = 3500) {
    el.toast.textContent = message;
    el.toast.dataset.kind = kind;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
  }

  function showError(node, message) {
    node.textContent = message;
    node.hidden = !message;
  }

  /* ==========================================================================
     Tabs
     ========================================================================== */
  function switchTab(name) {
    stopOrderTimers();
    el.orderView.hidden = true;
    state.currentTab = name;

    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.id === `tab-${name}`));
    $$('#tabbar button').forEach((b) => {
      if (b.dataset.tab === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    el.title.textContent = $(`#tab-${name}`).dataset.title;
    window.scrollTo(0, 0);

    if (name === 'home' || name === 'assets') refreshOrders();
  }

  /* ==========================================================================
     Deposit tiers
     ========================================================================== */
  function renderTiers() {
    el.tierList.innerHTML = '';
    state.tiers.forEach((tier) => {
      const li = document.createElement('li');
      li.className = 'tier';

      const info = document.createElement('div');
      const range = document.createElement('span');
      range.className = 'tier-range';
      range.textContent = `${inr(tier.min)} – ${inr(tier.max)}`;
      const note = document.createElement('span');
      note.className = 'tier-note';
      note.textContent = 'Pick any whole amount in this range';
      info.append(range, note);

      const buy = document.createElement('button');
      buy.type = 'button';
      buy.className = 'btn btn-primary';
      buy.textContent = 'Buy';
      buy.setAttribute('aria-label', `Buy in the ${inr(tier.min)} to ${inr(tier.max)} range`);
      buy.addEventListener('click', () => openPayDialog(tier));

      li.append(info, buy);
      el.tierList.append(li);
    });
  }

  /* ==========================================================================
     Payment-method dialog
     ========================================================================== */
  function openPayDialog(tier) {
    state.activeTier = tier;
    el.amountInput.min = tier.min;
    el.amountInput.max = tier.max;
    el.amountInput.value = tier.min;
    el.amountHint.textContent = `Enter a whole amount from ${inr(tier.min)} to ${inr(tier.max)}.`;
    showError(el.payError, '');
    el.payDialog.showModal();
  }

  $('#payCancel').addEventListener('click', () => el.payDialog.close());
  // Tap on the dimmed backdrop closes the sheet
  el.payDialog.addEventListener('click', (e) => {
    if (e.target === el.payDialog) el.payDialog.close();
  });

  el.payForm.addEventListener('submit', async (e) => {
    e.preventDefault(); // we close the dialog ourselves, after the order exists
    const tier = state.activeTier;
    const amount = Number(el.amountInput.value);
    const method = $('input[name="method"]:checked', el.payForm).value;

    if (!Number.isInteger(amount) || amount < tier.min || amount > tier.max) {
      return showError(el.payError, `Enter a whole amount between ${inr(tier.min)} and ${inr(tier.max)}.`);
    }
    showError(el.payError, '');

    el.payConfirm.disabled = true;
    el.payConfirm.textContent = 'Creating order…';
    try {
      const order = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ tierId: tier.id, amount, method }),
      });
      saveId(order.orderId);
      el.payDialog.close();
      showOrder(order);
    } catch (err) {
      showError(el.payError, err.message);
    } finally {
      el.payConfirm.disabled = false;
      el.payConfirm.textContent = 'Confirm';
    }
  });

  /* ==========================================================================
     Transaction information page
     ========================================================================== */
  function showOrder(order) {
    state.returnTab = state.currentTab;
    state.order = order;
    state.skew = order.serverTime - Date.now();

    $$('.tab').forEach((t) => t.classList.remove('is-active'));
    el.orderView.hidden = false;
    el.title.textContent = 'Order';

    el.utrInput.value = '';
    showError(el.utrError, '');
    renderOrder();
    startOrderTimers();
    window.scrollTo(0, 0);
    $('#orderTitle').focus({ preventScroll: true });
  }

  function renderOrder() {
    const o = state.order;
    const pending = o.status === 'pending';

    el.ticket.dataset.status = o.status;
    if (!pending) el.ticket.dataset.urgent = 'false';

    el.ordAmount.textContent = inr(o.amount);
    el.ordId.textContent = o.orderId;
    el.ordStatus.textContent = STATUS_LABEL[o.status];
    el.ordStatus.dataset.status = o.status;

    el.timerLabel.textContent = pending ? 'Expires in' : STATUS_LABEL[o.status];
    if (!pending) el.ordTimer.textContent = '--:--';

    // Payee rows (textContent only – never inject server values as HTML)
    const rows = [
      ['Payee name', o.payee.name],
      ['UPI ID (VPA)', o.payee.vpa],
      ['Account number', o.payee.account],
      ['IFSC', o.payee.ifsc],
    ];
    el.payeeRows.innerHTML = '';
    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'kv-row';
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      const span = document.createElement('span');
      span.textContent = value;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy';
      copy.textContent = 'Copy';
      copy.dataset.copy = value;
      copy.setAttribute('aria-label', `Copy ${label}`);
      dd.append(span, copy);
      row.append(dt, dd);
      el.payeeRows.append(row);
    });

    // Controls only make sense while the order is waiting for payment
    el.goBtn.hidden = !pending;
    el.goHint.hidden = !pending;
    el.utrForm.hidden = !pending;
    renderNotice(o);
  }

  function renderNotice(o) {
    const copy = {
      submitted: ['success', 'UTR received', `We'll match ${o.utr || 'your UTR'} with our bank statement and update this order.`],
      verified: ['success', 'Payment verified', `Your deposit of ${inr(o.amount)} is confirmed.`],
      rejected: ['error', 'Payment rejected', "We couldn't match this payment. Contact support and share your Order ID."],
      expired: ['error', 'Order expired', 'Start a new deposit from the Deposit tab. Already paid? Contact support with your Order ID.'],
    }[o.status];

    el.utrDone.hidden = !copy;
    if (!copy) return;
    el.utrDone.className = `notice notice-${copy[0]}`;
    el.utrDone.innerHTML = '';
    const title = document.createElement('p');
    title.className = 'notice-title';
    title.textContent = copy[1];
    const body = document.createElement('p');
    body.textContent = copy[2];
    el.utrDone.append(title, body);
  }

  /* ---------- Countdown + status polling ---------- */
  function startOrderTimers() {
    stopOrderTimers();
    tick();
    state.timerId = setInterval(tick, 1000);
    state.pollId = setInterval(poll, 8000);
  }

  function stopOrderTimers() {
    clearInterval(state.timerId);
    clearInterval(state.pollId);
    state.timerId = state.pollId = null;
  }

  function tick() {
    const o = state.order;
    if (!o || o.status !== 'pending') return;

    const left = o.expiresAt - (Date.now() + state.skew);
    if (left <= 0) {
      o.status = 'expired';
      renderOrder();
      poll();
      return;
    }
    const m = String(Math.floor(left / 60000)).padStart(2, '0');
    const s = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    el.ordTimer.textContent = `${m}:${s}`;
    el.ticket.dataset.urgent = String(left < 120000); // last two minutes turn red
  }

  async function poll() {
    const o = state.order;
    if (!o || el.orderView.hidden) return;
    try {
      const fresh = await api(`/api/orders/${o.orderId}`);
      if (state.order && state.order.orderId === fresh.orderId && fresh.status !== state.order.status) {
        state.order = fresh;
        state.skew = fresh.serverTime - Date.now();
        renderOrder();
        if (fresh.status === 'verified') toast('Payment verified. Your deposit is confirmed.', 'success', 5000);
        if (fresh.status === 'rejected') toast("Payment couldn't be matched.", 'error', 5000);
      }
      if (['verified', 'rejected', 'expired'].includes(fresh.status)) stopOrderTimers();
    } catch {
      /* network hiccup – try again on the next tick */
    }
  }

  /* ---------- Back button ---------- */
  $('#backBtn').addEventListener('click', () => switchTab(state.returnTab || 'deposit'));

  /* ---------- Copy to clipboard ---------- */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea'); // fallback for http / older browsers
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied', 'success', 1500);
  }

  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy');
    if (copyBtn) {
      const text = copyBtn.dataset.copy ?? $(`#${copyBtn.dataset.copyFrom}`)?.textContent;
      if (text) copyText(text);
      return;
    }
    const go = e.target.closest('[data-goto]');
    if (go) switchTab(go.dataset.goto);
  });

  /* ==========================================================================
     UPI deep link – "Go to Transfer"
     ========================================================================== */
  function buildUpiLink(order) {
    const p = order.payee;
    const query = [
      ['pa', p.vpa],                       // payee address (UPI ID)
      ['pn', p.name],                      // payee name
      ['am', order.amount.toFixed(2)],     // amount
      ['cu', 'INR'],                       // currency
      ['tn', `Order ${order.orderId}`],    // note shown in the payer's app
    ]
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return `${UPI_SCHEMES[order.method] || UPI_SCHEMES.upi}?${query}`;
  }

  el.goBtn.addEventListener('click', () => {
    const order = state.order;
    if (!order || order.status !== 'pending') return;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isMobile) {
      toast('UPI apps open on phones. Copy the UPI ID and pay from your phone.', 'info', 5000);
      return;
    }

    // If the page never loses visibility, no app took the link – tell the user what to do next.
    let left = false;
    const onVisibility = () => { if (document.hidden) left = true; };
    document.addEventListener('visibilitychange', onVisibility);

    window.location.href = buildUpiLink(order);

    setTimeout(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (!left) toast("No app opened? Copy the UPI ID above and pay from your UPI app.", 'info', 6000);
    }, 2000);
  });

  /* ==========================================================================
     UTR submission
     ========================================================================== */
  el.utrInput.addEventListener('input', () => {
    el.utrInput.value = el.utrInput.value.replace(/\D/g, '').slice(0, 12);
    showError(el.utrError, '');
  });

  el.utrForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const utr = el.utrInput.value.trim();
    if (!UTR_RE.test(utr)) {
      return showError(el.utrError, 'Enter the 12-digit UTR from your payment app.');
    }

    el.utrBtn.disabled = true;
    el.utrBtn.textContent = 'Submitting…';
    try {
      const updated = await api(`/api/orders/${state.order.orderId}/utr`, {
        method: 'POST',
        body: JSON.stringify({ utr }),
      });
      state.order = updated;
      state.skew = updated.serverTime - Date.now();
      renderOrder();
      toast("UTR submitted. We'll verify your payment shortly.", 'success', 5000);
    } catch (err) {
      showError(el.utrError, err.message);
    } finally {
      el.utrBtn.disabled = false;
      el.utrBtn.textContent = 'Submit UTR';
    }
  });

  /* ==========================================================================
     Assets + Home summary
     ========================================================================== */
  async function refreshOrders() {
    const ids = readIds();
    let list = [];
    if (ids.length) {
      try {
        list = (await api(`/api/orders?ids=${encodeURIComponent(ids.join(','))}`)).orders;
      } catch {
        /* offline – show whatever is on screen */
      }
    }
    renderOrders(list);
  }

  function renderOrders(list) {
    const sum = (status) => list.filter((o) => o.status === status).reduce((t, o) => t + o.amount, 0);
    const open = list.filter((o) => o.status === 'pending' || o.status === 'submitted').length;

    $('#homeVerified').textContent = inr(sum('verified'));
    $('#homeOpen').textContent = String(open);
    $('#assetVerified').textContent = inr(sum('verified'));
    $('#assetPending').textContent = inr(sum('submitted'));

    el.orderList.innerHTML = '';
    el.ordersEmpty.hidden = list.length > 0;

    list.forEach((o) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'order-item';

      const left = document.createElement('span');
      const amt = document.createElement('span');
      amt.className = 'amt';
      amt.textContent = inr(o.amount);
      const meta = document.createElement('span');
      meta.className = 'meta';
      const when = new Date(o.createdAt).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
      });
      meta.textContent = `${METHOD_LABEL[o.method] || 'UPI'}, ${when}`;
      left.append(amt, meta);

      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.status = o.status;
      chip.textContent = STATUS_LABEL[o.status];

      btn.append(left, chip);
      btn.addEventListener('click', () => showOrder(o));
      li.append(btn);
      el.orderList.append(li);
    });
  }

  /* ==========================================================================
     Tool tab – find an order by ID
     ========================================================================== */
  $('#lookupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#lookupError');
    const id = $('#lookupInput').value.trim().toUpperCase();
    if (!ORDER_ID_RE.test(id)) return showError(err, 'Order IDs start with DP, for example DP1A2B3C4D5E6F.');
    showError(err, '');
    try {
      const order = await api(`/api/orders/${id}`);
      saveId(order.orderId);
      showOrder(order);
    } catch (e2) {
      showError(err, e2.message);
    }
  });

  /* ==========================================================================
     Boot
     ========================================================================== */
  $$('#tabbar button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  async function init() {
    try {
      const config = await api('/api/config');
      state.tiers = config.tiers;
      renderTiers();
    } catch {
      el.tierList.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'tier-skeleton';
      li.textContent = "Couldn't load amounts. Check your connection and reload.";
      el.tierList.append(li);
    }
    refreshOrders();
  }

  init();
})();
