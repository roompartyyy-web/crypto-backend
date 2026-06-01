require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, "db.json");

// ================= CONFIG API =================
const ALCHEMY_KEY = process.env.ALCHEMY_KEY;
const TRONGRID_KEY = process.env.TRONGRID_KEY;

// ================= EXPIRATION =================
const EXPIRATION = {
    BTC: 45 * 60 * 1000,
    ETH: 45 * 60 * 1000,
    SOL: 45 * 60 * 1000,
    TRC20: 45 * 60 * 1000
};

// ================= DB =================
function loadDB() {
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify({
            sessions: [],
            pools: {},
            pool_index: {}
        }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ================= CLEAN =================
function cleanup(db) {
    const now = Date.now();

    for (const s of db.sessions) {
        if (s.status === "pending" && now > new Date(s.expires_at).getTime()) {
            s.status = "expired";
        }
    }
}

// ================= ROUND ROBIN =================
function getNextAddress(db, method) {
    const pool = db.pools?.[method] || [];
    if (!pool.length) return null;

    if (!db.pool_index) db.pool_index = {};
    if (!db.pool_index[method]) db.pool_index[method] = 0;

    const index = db.pool_index[method] % pool.length;
    const address = pool[index];

    db.pool_index[method]++;

    return address;
}

// ======================================================
// 🔥 STEP 3 CORE : BLOCKCHAIN VERIFICATION ENGINE
// ======================================================

async function verifyBTC(txid, address, expectedAmount) {
    const url = `https://mempool.space/api/tx/${txid}`;

    const res = await axios.get(url);
    const data = res.data;

    let total = 0;

    for (const output of data.vout) {
        if (output.scriptpubkey_address === address) {
            total += output.value;
        }
    }

    return total >= expectedAmount * 100000000;
}

async function verifyETH(txid, address, expectedAmount) {
    const url = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

    const res = await axios.post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionByHash",
        params: [txid]
    });

    const tx = res.data.result;

    if (!tx) return false;

    return tx.to?.toLowerCase() === address.toLowerCase();
}

async function verifySOL(txid, address, expectedAmount) {
    const url = "https://api.mainnet-beta.solana.com";

    const res = await axios.post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [txid, "jsonParsed"]
    });

    const tx = res.data.result;
    if (!tx) return false;

    const instructions = tx.transaction.message.instructions;

    return instructions.some(i =>
        i.parsed?.info?.destination === address
    );
}

async function verifyTRC20(txid, address, expectedAmount) {
    const url = `https://api.trongrid.io/v1/transactions/${txid}`;

    const res = await axios.get(url, {
        headers: {
            "TRON-PRO-API-KEY": TRONGRID_KEY
        }
    });

    const data = res.data;

    return data?.data?.[0]?.to === address;
}

// ================= UNIFIED CHECK =================
async function verifyBlockchain(txid, method, address, expectedAmount) {

    if (!txid) return false;

    if (method === "BTC") return await verifyBTC(txid, address, expectedAmount);
    if (method === "ETH") return await verifyETH(txid, address, expectedAmount);
    if (method === "SOL") return await verifySOL(txid, address, expectedAmount);
    if (method === "USDTTRC20") return await verifyTRC20(txid, address, expectedAmount);

    return false;
}

// ================= INIT PAYMENT =================
app.post("/api/payment/init", (req, res) => {

    const { pack, wallet, payment_method } = req.body;

    const db = loadDB();
    cleanup(db);

    if (!pack || !wallet || !payment_method) {
        return res.status(400).json({ msg: "missing fields" });
    }

    const [usd, token] = pack.split("|");

    const address = getNextAddress(db, payment_method);

    if (!address) {
        return res.status(400).json({ msg: "no pool address" });
    }

    const session = {
        session_id: uuidv4(),
        wallet,
        payment_method,
        payment_address: address,

        expected_usd: Number(usd),
        expected_token: Number(token),

        status: "pending",
        txid: null,

        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + EXPIRATION[payment_method]).toISOString()
    };

    db.sessions.push(session);
    saveDB(db);

    res.json({
        success: true,
        session_id: session.session_id,
        address,
        expires_at: session.expires_at
    });
});

// ================= WEBHOOK PAYMENT =================
app.post("/api/webhook/paid", async (req, res) => {

    const { session_id, txid } = req.body;

    const db = loadDB();

    const session = db.sessions.find(s => s.session_id === session_id);

    if (!session) {
        return res.status(404).json({ msg: "session not found" });
    }

    if (session.status === "paid") {
        return res.json({ success: true, msg: "already paid" });
    }

    if (session.status === "expired") {
        return res.status(400).json({ msg: "expired session" });
    }

    // ================= REAL CHECK =================
    const ok = await verifyBlockchain(
        txid,
        session.payment_method,
        session.payment_address,
        session.expected_usd
    );

    if (!ok) {
        return res.status(400).json({
            msg: "transaction not confirmed on blockchain"
        });
    }

    session.status = "paid";
    session.txid = txid;
    session.paid_at = new Date().toISOString();

    saveDB(db);

    res.json({ success: true });
});

// ================= STATUS =================
app.get("/api/payment/status/:id", (req, res) => {

    const db = loadDB();
    const session = db.sessions.find(s => s.session_id === req.params.id);

    if (!session) return res.status(404).json({ msg: "not found" });

    res.json(session);
});

// ================= START =================
app.listen(3000, () => {
    console.log("🚀 STEP 3 BLOCKCHAIN VERIFICATION LIVE");
});