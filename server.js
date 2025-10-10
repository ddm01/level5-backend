/*───────────────────────────────────────────────────────────
  Level 5 Backend — Express on Render (Free)
  Endpoints:
    GET /health
    GET /search?store=coles|woolworths&q=oreo
    GET /cheapest?q=plain flour 1kg
    GET /bulk-cheapest-perkg?items=Flour,Sugar,Cocoa Powder,Baking Powder,Vegetable Oil
───────────────────────────────────────────────────────────*/

const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const camelCase = require('camelcase-keys');

const app  = express();
const PORT = process.env.PORT || 8080; // Render provides PORT

// Allow itch.io + localhost for testing
const allowed = [
  /https:\/\/.*\.itch\.io$/,
  /http:\/\/localhost(:\d+)?$/,
  /https:\/\/localhost(:\d+)?$/
];
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = allowed.some(r => r.test(origin));
    cb(ok ? null : new Error("CORS blocked"), ok);
  },
  credentials: true
}));
app.use(express.json());

function getApiInfo(store) {
  const s = (store || '').toLowerCase();
  if (s === 'coles')
    return { host: 'coles-product-price-api.p.rapidapi.com', path: '/coles/product-search' };
  if (s === 'woolworths')
    return { host: 'woolworths-products-api.p.rapidapi.com', path: '/woolworths/product-search/' };
  return null;
}

function ensureKey() {
  if (!process.env.RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY missing (set in Render env vars)');
}
function toNumber(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^\d.]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
}
function unitToKg(q, u) { u=(u||'').toLowerCase(); if(u==='g')return q/1000; if(u==='kg')return q; if(u==='ml')return q/1000; if(u==='l')return q; return null; }
function sizeToKg(s='') {
  let m = s.match(/(\d+)\s*x\s*([\d.]+)\s*(g|kg|ml|l)\b/i);
  if (m) return Number(m[1]) * unitToKg(Number(m[2]), m[3]);
  m = s.match(/([\d.]+)\s*(g|kg|ml|l)\b/i);
  if (m) return unitToKg(Number(m[1]), m[2]);
  return null;
}

/* small cache to reduce RapidAPI calls */
const cache = new Map();
const putCache = (k, v, ttl = 45000) => cache.set(k, { until: Date.now() + ttl, value: v });
const getCache = (k) => {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() > hit.until) { cache.delete(k); return null; }
  return hit.value;
};

async function callStoreSearch(store, query, page = 1, size = 15) {
  ensureKey();
  const api = getApiInfo(store);
  if (!api) throw new Error('store must be coles or woolworths');

  const key = `S:${store}|q:${query}|p:${page}|s:${size}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `https://${api.host}${api.path}`;
  const params = { query, search: query, page, size }; // send both; unused is ignored

  const r = await axios.get(url, {
    params,
    headers: {
      'x-rapidapi-key' : process.env.RAPIDAPI_KEY,
      'x-rapidapi-host': api.host
    },
    timeout: 12000
  });

  const out = [];
  for (const raw of r.data.results ?? []) {
    const obj   = camelCase(raw, { deep: true });
    const sizeS = obj.productSize || obj.packageSize || obj.size || '';
    const kg    = sizeToKg(sizeS);
    const price = toNumber(obj.currentPrice ?? obj.price ?? obj.Price);
    const link  = obj.productUrl || obj.url || obj.link || '';
    const id    = obj.productId || obj.id || obj.sku || '';

    out.push({
      product: obj.productName || obj.name || '',
      size: sizeS,
      price,
      pricePerKg: (kg && price) ? +(price / kg).toFixed(2) : null,
      url: link,
      id
    });
  }

  putCache(key, out);
  return out;
}

/* routes */
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/search', async (req, res) => {
  try {
    const { store = 'coles', q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing ?q=' });
    const list = await callStoreSearch(store, q, 1, 15);
    res.json(list);
  } catch (e) {
    console.error('GET /search ->', (e.response && e.response.data) || e.message);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.get('/cheapest', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing ?q=' });

    const [coles, woolworths] = await Promise.all([
      callStoreSearch('coles', q, 1, 15),
      callStoreSearch('woolworths', q, 1, 15)
    ]);
    const all = [...coles, ...woolworths].filter(p => p && p.price != null);

    const byItem = all.reduce((best, p) => (!best || (p.price ?? Infinity) < (best.price ?? Infinity) ? p : best), null);
    const withKg = all.filter(p => p.pricePerKg != null);
    const byKg   = withKg.reduce((best, p) => (!best || p.pricePerKg < best.pricePerKg ? p : best), null);

    const guessStore = (p) => (p && p.url || '').toLowerCase().includes('woolworths') ? 'woolworths'
                         : (p && p.url || '').toLowerCase().includes('coles') ? 'coles' : undefined;

    res.json({
      query: q,
      cheapestByItem: byItem ? { store: guessStore(byItem), ...byItem } : null,
      cheapestByKg:   byKg   ? { store: guessStore(byKg),   ...byKg   } : null
    });
  } catch (e) {
    console.error('GET /cheapest ->', (e.response && e.response.data) || e.message);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.get('/bulk-cheapest-perkg', async (req, res) => {
  try {
    const items = (req.query.items || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!items.length) return res.status(400).json({ error: 'Provide ?items=Flour,Sugar,...' });

    const out = [];
    for (const name of items) {
      const [coles, woolworths] = await Promise.all([
        callStoreSearch('coles', name, 1, 15),
        callStoreSearch('woolworths', name, 1, 15)
      ]);

      const all  = [...coles, ...woolworths].filter(p => p && p.price != null && p.pricePerKg != null);
      const best = all.reduce((b, p) => (!b || p.pricePerKg < b.pricePerKg) ? p : b, null);

      const guessStore = (p) => (p && p.url || '').toLowerCase().includes('woolworths') ? 'woolworths'
                           : (p && p.url || '').toLowerCase().includes('coles') ? 'coles' : undefined;

      out.push({ name, cheapestPerKg: best ? { store: guessStore(best), ...best } : null });
    }

    res.json({ items: out });
  } catch (e) {
    console.error('GET /bulk-cheapest-perkg ->', (e.response && e.response.data) || e.message);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🟢 Render service listening on :${PORT}`);
});
