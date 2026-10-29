# IronPulse Gym App (frontend + backend)

Node.js + Express + SQLite. Mobile-OTP login, owner/member roles enforced on the server, attendance, payments,
notifications, AI chatbot. The frontend (`public/index.html`) is served by the same server.

## 1. Run locally (5 minutes)
```
npm install
cp .env.example .env        # then edit: set JWT_SECRET and OWNER_PHONES
npm run dev                 # DEV_OTP=true: the OTP is shown on screen, no SMS needed
```
Open http://localhost:3000. Sign in with a number listed in OWNER_PHONES to get the **Owner Panel**; any other number is a **member**.

## 2. Go live
Environment variables are listed in `.env.example`. In production set DEV_OTP=false (or remove it), a strong JWT_SECRET,
Twilio credentials (OTP SMS) and optionally ANTHROPIC_API_KEY (chatbot).

**Render / Railway (easiest)**: push this folder to GitHub, create a "Web Service" from the repo (Docker or Node, start command `node server.js`).
Add the env vars. **Attach a persistent disk** (e.g. mounted at `/data`) and set `DB_FILE=/data/gym.db`, otherwise SQLite data is lost on redeploy.

**VPS (DigitalOcean, AWS Lightsail, etc.)**:
```
docker build -t ironpulse . && docker run -d --restart=always -p 3000:3000 --env-file .env -v ironpulse-data:/data -e DB_FILE=/data/gym.db ironpulse
```
Put Nginx or Caddy in front for free HTTPS (Let's Encrypt) and point your domain at the server. Always serve over HTTPS.

**Backups**: copy the SQLite file (`DB_FILE`) daily, e.g. a cron job with `sqlite3 gym.db ".backup backup.db"`.

## 3. How the pieces connect
```
public/index.html  --fetch /api/...-->  server.js  --store.get/put/del/list-->  database
```
- Auth: `/api/otp` sends a code, `/api/verify` returns a 30-day token. Owner = phone in OWNER_PHONES (checked on every request).
- Data: documents in collections `members, payments, attendance, inbox, notices, broadcast, settings`.
  Permissions live in `RULES` and `CLEAN` in server.js (members can only read/write their own docs; only the owner writes payments).
- Chatbot: `/api/chat` builds the member's context from the database and calls the Claude API; the key never reaches the browser.

## 4. Using a different database
Only the `store` object near the top of server.js touches the database (4 async methods: `get, put, del, list`).
Replace it and nothing else changes.

PostgreSQL (`npm i pg`), a table `docs(path text primary key, col text, data jsonb)`:
```js
const { Pool } = require('pg'); const pg = new Pool({ connectionString: process.env.DATABASE_URL });
const store = {
  get: async (c,i) => (await pg.query('select data from docs where path=$1',[c+'/'+i])).rows[0]?.data || null,
  put: async (c,i,x) => { await pg.query('insert into docs(path,col,data) values($1,$2,$3) on conflict(path) do update set data=$3',[c+'/'+i,c,x]); },
  del: async (c,i) => { await pg.query('delete from docs where path=$1',[c+'/'+i]); },
  list: async c => (await pg.query('select path,data from docs where col=$1',[c])).rows.map(r=>({id:r.path.split('/')[1],data:r.data}))
};
```
MongoDB (`npm i mongodb`): one collection `docs` with `_id: "col/id"`, `col`, `data`; `get` = findOne, `put` = replaceOne with upsert, `del` = deleteOne, `list` = find({col}).
Firebase/Firestore works the same way: `db.collection(c).doc(i)`.
If you later want proper relational tables (members, payments rows), keep the same 4 route handlers and map each collection to its table inside `store`.

## 5. Adding other things
- **Online payments (Razorpay)**: add `POST /api/pay/order` (create order with the Razorpay SDK) and a webhook `POST /api/pay/webhook`
  that verifies the signature, then writes the payment into `payments/<userId>` exactly like the owner's "Record payment" does
  (append to `entries`, extend `due`). The Payments tab already displays whatever is in that document.
- **Other SMS providers (MSG91, Fast2SMS)**: edit only `sendSms()`. For India, commercial SMS needs DLT registration.
- **WhatsApp/email notifications**: call your provider inside the `PUT /api/doc/notices/...` handler after saving.
- **Realtime**: the frontend polls every 5 s (`setInterval` in index.html). For instant updates swap in Server-Sent Events or WebSockets.
- **New screens**: add a view in `index.html` (see `VW.o` / `VW.m`), a new collection name in `RULES`, and use `rd/wr/wcol/wdoc`.
