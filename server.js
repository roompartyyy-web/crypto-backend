require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { PublicKey } = require("@solana/web3.js");

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, "db.json");

// ---------------- CONFIG ----------------
const EXPIRATION_MS = 45 * 60 * 1000;

// ---------------- DB ----------------
function loadDB() {
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify({
            sessions: [],
            used_wallets: {},
            pool_index: {}
        }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------------- SOL CHECK ----------------
function validateSolana(addr) {
    try { new PublicKey(addr); return true; }
    catch { return false; }
}

// ---------------- CLEAN EXPIRED ----------------
function clean(db) {
    const now = Date.now();

    db.sessions = db.sessions.filter(s => {
        const expired = now > new Date(s.expires_at).getTime();

        if (expired && s.status === "pending") {
            s.status = "expired";
        }

        return !expired;
    });
}

// ---------------- ROUND ROBIN ----------------
function getAddress(db, method) {
    const pool = db.pools?.[method] || [];
    if (!pool.length) return null;

    if (!db.pool_index[method]) db.pool_index[method] = 0;

    const start = db.pool_index[method];

    for (let i = 0; i < pool.length; i++) {
        const addr = pool[(start + i) % pool.length];

        const used = db.sessions.some(
            s => s.payment_address === addr && s.status === "pending"
        );

        if (!used) {
            db.pool_index[method] = (start + i + 1) % pool.length;
            return addr;
        }
    }

    return null;
}

// ---------------- AUTO CLEAN LOOP ----------------
setInterval(() => {
    const db = loadDB();
    clean(db);
    saveDB(db);
}, 60 * 1000);

// ---------------- INIT ----------------
app.post("/api/payment/init", (req, res) => {
    const { pack, wallet, payment_method } = req.body;

    const db = loadDB();
    clean(db);

    if (!pack || !wallet || !payment_method)
        return res.status(400).json({ msg: "missing fields" });

    if (payment_method === "SOL" && !validateSolana(wallet))
        return res.status(400).json({ msg: "invalid wallet" });

    const address = getAddress(db, payment_method);
    if (!address)
        return res.status(400).json({ msg: "no address available" });

    const session = {
        session_id: uuidv4(),
        wallet,
        pack,
        payment_method,
        payment_address: address,
        status: "pending",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + EXPIRATION_MS).toISOString(),
        txid: null
    };

    db.sessions.push(session);

    saveDB(db);

    res.json({
        success: true,
        session_id: session.session_id,
        unique_payment_address: address,
        expires_at: session.expires_at
    });
});

// ---------------- WEBHOOK ----------------
app.post("/api/webhook/paid", (req, res) => {
    const { session_id, txid } = req.body;

    const db = loadDB();

    const s = db.sessions.find(x => x.session_id === session_id);
    if (!s) return res.status(404).json({ msg: "session not found" });

    s.status = "paid";
    s.txid = txid;

    saveDB(db);

    res.json({ success: true });
});

// ---------------- STATUS ----------------
app.get("/api/payment/status/:id", (req, res) => {
    const db = loadDB();
    const s = db.sessions.find(x => x.session_id === req.params.id);

    if (!s) return res.status(404).json({ msg: "not found" });

    res.json(s);
});

// ---------------- START ----------------
app.listen(3000, () => {
    console.log("🚀 Crypto Backend V3 FIX running");
});