require('dotenv').config();
const express = require('express'), helmet = require('helmet'), jwt = require('jsonwebtoken'),
  crypto = require('crypto'), path = require('path'), Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000, SECRET = process.env.JWT_SECRET || '', CC = process.env.COUNTRY_CODE || '+91',
  TZ = process.env.TZ || 'Asia/Kolkata', DEV = process.env.DEV_OTP === 'true';
if (SECRET.length < 24) { console.error('Set JWT_SECRET (24+ characters) in .env'); process.exit(1); }
const OWNERS = new Set((process.env.OWNER_PHONES || '').split(',').map(s => s.replace(/\D/g, '').slice(-10)).filter(Boolean));
if (!OWNERS.size) console.warn('Warning: OWNER_PHONES is empty, nobody can open the Owner Panel.');

/* ============ STORAGE ADAPTER ============
   The whole app talks to storage ONLY through these 4 async methods.
   To use PostgreSQL / MongoDB / Firebase / MySQL, re-implement get, put, del and list
   (examples in README.md). Nothing else in this file or the frontend changes. */
const store = (() => {
  const db = new Database(process.env.DB_FILE || 'gym.db');
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, col TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER);
           CREATE INDEX IF NOT EXISTS docs_col ON docs(col);`);
  const g = db.prepare('SELECT data FROM docs WHERE path=?'),
    p = db.prepare('INSERT INTO docs(path,col,data,updated) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated=excluded.updated'),
    d = db.prepare('DELETE FROM docs WHERE path=?'), l = db.prepare('SELECT path,data FROM docs WHERE col=?');
  return {
    get: async (c, i) => { const r = g.get(c + '/' + i); return r ? JSON.parse(r.data) : null; },
    put: async (c, i, x) => { p.run(c + '/' + i, c, JSON.stringify(x), Date.now()); },
    del: async (c, i) => { d.run(c + '/' + i); },
    list: async c => l.all(c).map(r => ({ id: r.path.split('/')[1], data: JSON.parse(r.data) }))
  };
})();

/* ============ PERMISSIONS ============
   'self' = a member may touch only the document whose id equals their own user id.
   'all'  = every signed-in user.  The owner can read/write every collection below.
   Collections starting with "_" (OTPs, users) are never reachable through the API. */
const RULES = {
  members: { self: 'rw' }, payments: { self: 'r' }, attendance: { self: 'rw' },
  inbox: { self: 'rw' }, notices: { self: 'r' }, broadcast: { all: 'r' }, settings: { all: 'r' }
};
function can(u, col, id, act) {
  const r = RULES[col]; if (!r) return false;
  if (u.role === 'owner') return true;
  if (r.all && r.all.includes(act)) return true;
  return !!(r.self && id === u.id && r.self.includes(act));
}
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
// Members can only write sanitized data, so they cannot forge names, phones or old attendance.
const CLEAN = {
  members: (d, u, old) => ({ name: str(d.name, 60) || u.name, phone: u.phone, joined: (old && old.joined) || today() }),
  attendance: (d, u, old) => {
    const had = new Set((old && old.days) || []), t = today();
    const add = (Array.isArray(d.days) ? d.days : []).filter(x => /^\d{4}-\d\d-\d\d$/.test(x) && (had.has(x) || x === t));
    return { name: u.name, days: [...new Set([...had, ...add])].sort().slice(-200), last: Date.now() };
  },
  inbox: (d, u) => ({
    name: u.name, phone: u.phone,
    items: (Array.isArray(d.items) ? d.items : []).slice(0, 40).map(i => ({ id: str(i.id, 20), text: str(i.text, 500), ts: Number(i.ts) || Date.now() }))
  })
};

/* ============ HELPERS ============ */
const hash = (otp, phone) => crypto.createHash('sha256').update(otp + ':' + phone + ':' + SECRET).digest('hex');
const clean10 = s => String(s || '').replace(/\D/g, '').slice(-10);
const pub = (phone, name) => ({ id: 'u' + phone, phone, name, role: OWNERS.has(phone) ? 'owner' : 'member' });
const idOk = x => /^[A-Za-z0-9_-]{1,64}$/.test(x);
const hits = new Map();
function limited(k, max, ms) { const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < ms); a.push(n); hits.set(k, a); return a.length > max; }
setInterval(() => hits.clear(), 3600e3).unref();
const wrap = f => (q, s) => f(q, s).catch(e => { console.error(e); s.status(500).json({ error: 'Server error' }); });

async function sendSms(phone, text) {
  const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from) return false;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: CC + phone, From: from, Body: text })
  });
  if (!r.ok) throw new Error('SMS provider error ' + r.status);
  return true;
}

/* ============ APP ============ */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }), express.json({ limit: '100kb' }));

async function auth(q, s, n) {
  let u;
  try {
    const { phone } = jwt.verify((q.headers.authorization || '').replace('Bearer ', ''), SECRET);
    const rec = await store.get('_user', phone); if (!rec) throw new Error('no user');
    u = pub(phone, rec.name);
  } catch (e) { return s.status(401).json({ error: 'Please sign in again' }); }
  q.user = u; n();
}

app.post('/api/otp', wrap(async (q, s) => {
  const phone = clean10(q.body.phone), name = str(q.body.name, 60).trim();
  if (!/^\d{10}$/.test(phone) || name.length < 2) return s.status(400).json({ error: 'Enter a valid name and 10-digit mobile number' });
  if (limited('otp:' + phone, 5, 3600e3) || limited('ip:' + q.ip, 20, 3600e3)) return s.status(429).json({ error: 'Too many OTP requests. Try again later.' });
  const otp = String(crypto.randomInt(100000, 1000000));
  await store.put('_otp', phone, { hash: hash(otp, phone), exp: Date.now() + 5 * 60e3, tries: 0 });
  let sent = false;
  try { sent = await sendSms(phone, `Your IronPulse login code is ${otp}. Valid for 5 minutes.`); }
  catch (e) { console.error(e.message); return s.status(502).json({ error: 'Could not send the SMS. Try again.' }); }
  if (!sent) { if (DEV) return s.json({ ok: true, dev: otp }); return s.status(503).json({ error: 'SMS is not configured on the server' }); }
  s.json({ ok: true });
}));

app.post('/api/verify', wrap(async (q, s) => {
  const phone = clean10(q.body.phone), otp = str(q.body.otp, 6).trim(), name = str(q.body.name, 60).trim();
  const r = await store.get('_otp', phone);
  if (!r || r.exp < Date.now() || r.tries >= 5) return s.status(400).json({ error: 'Code expired. Request a new one.' });
  const ok = crypto.timingSafeEqual(Buffer.from(hash(otp, phone)), Buffer.from(r.hash));
  if (!ok) { r.tries++; await store.put('_otp', phone, r); return s.status(400).json({ error: 'Wrong code' }); }
  await store.del('_otp', phone);
  const old = await store.get('_user', phone);
  await store.put('_user', phone, { name: name || (old && old.name) || 'Member' });
  s.json({ token: jwt.sign({ phone }, SECRET, { expiresIn: '30d' }), user: pub(phone, name || (old && old.name) || 'Member') });
}));

app.get('/api/me', auth, (q, s) => s.json({ user: q.user }));

app.get('/api/doc/:c/:id', auth, wrap(async (q, s) => {
  const { c, id } = q.params;
  if (!idOk(id) || !can(q.user, c, id, 'r')) return s.status(403).json({ error: 'Not allowed' });
  s.json({ data: await store.get(c, id) });
}));

app.put('/api/doc/:c/:id', auth, wrap(async (q, s) => {
  const { c, id } = q.params, u = q.user;
  if (!idOk(id) || !can(u, c, id, 'w')) return s.status(403).json({ error: 'Not allowed' });
  let d = q.body;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return s.status(400).json({ error: 'Invalid data' });
  if (u.role !== 'owner') d = CLEAN[c](d, u, await store.get(c, id));
  await store.put(c, id, d); s.json({ ok: true });
}));

app.delete('/api/doc/:c/:id', auth, wrap(async (q, s) => {
  const { c, id } = q.params;
  if (q.user.role !== 'owner' || !idOk(id) || !RULES[c]) return s.status(403).json({ error: 'Not allowed' });
  await store.del(c, id); s.json({ ok: true });
}));

app.get('/api/col/:c', auth, wrap(async (q, s) => {
  if (q.user.role !== 'owner' || !RULES[q.params.c]) return s.status(403).json({ error: 'Not allowed' });
  s.json({ docs: await store.list(q.params.c) });
}));

/* AI chatbot: the server builds the context from the member's own records, so the API key stays private. */
app.post('/api/chat', auth, wrap(async (q, s) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return s.status(503).json({ error: 'Chatbot not configured' });
  if (limited('chat:' + q.user.id, 30, 3600e3)) return s.status(429).json({ error: 'Chat limit reached. Try again later.' });
  let m = (Array.isArray(q.body.messages) ? q.body.messages : []).slice(-12)
    .map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: str(x.content, 1000) })).filter(x => x.content);
  while (m.length && m[0].role !== 'user') m.shift();
  if (!m.length || m[m.length - 1].role !== 'user') return s.status(400).json({ error: 'Invalid chat' });
  const st = (await store.get('settings', 'gym')) || {}, pay = await store.get('payments', q.user.id), att = await store.get('attendance', q.user.id);
  const days = (att && att.days) || [];
  const system = `You are Pulse, the friendly assistant of ${st.name || 'IronPulse Fitness'}, a gym. Member: ${q.user.name}. Reply concisely (under 120 words unless asked for detail), plain text, no markdown tables.
You know workouts (push/pull/legs, 5-day split, lean and bulk plans), HIIT, calories (Mifflin-St Jeor BMR x activity; -400 kcal to cut, +350 to lean bulk), protein (1.6-2.2 g/kg; eggs, chicken, fish, paneer, soya, dal, whey), hydration, sleep and form.
Gym info: timings ${st.timings || 'ask the front desk'}; plans ${(st.plans || []).map(p => `${p.n} Rs ${p.fee} for ${p.m} month(s)`).join(', ') || 'ask the front desk'}; payment modes Cash, UPI, Card, Net banking${st.upi ? '; UPI ID ' + st.upi : ''}.
This member's data (use it, never invent): ${pay ? `plan ${pay.plan}, fee ${pay.fee}, valid till ${pay.due}, last payments ${JSON.stringify((pay.entries || []).slice(0, 3))}` : 'no plan assigned yet'}; today is ${today()}; total visits ${days.length}; recent visits ${days.slice(-7).join(', ') || 'none'}.
You are not a doctor: for injuries or medical conditions advise seeing a professional. If you cannot help or the member wants a human, tell them to use "Message the owner" in the Alerts tab.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 600, system, messages: m })
  });
  if (!r.ok) { console.error('Claude API', r.status, await r.text()); return s.status(502).json({ error: 'Assistant unavailable' }); }
  const j = await r.json();
  s.json({ text: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') });
}));

app.get('/healthz', (q, s) => s.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log('IronPulse running on port ' + PORT + (DEV ? ' (DEV_OTP on)' : '')));
