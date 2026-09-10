const crypto = require("crypto");
const { Pool } = require("pg");
const express = require("express");

const originalExpress = express;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

const TOKEN_SECRET = process.env.AUTH_SECRET || process.env.JWT_SECRET || "flight-app-change-this-secret";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

function base64url(value) {
    return Buffer.from(value).toString("base64url");
}

function signToken(userId) {
    const payload = {
        sub: String(userId),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
    };
    const encoded = base64url(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", TOKEN_SECRET).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
}

function verifyToken(token) {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(parts[0]).digest("base64url");
    const a = Buffer.from(parts[1]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
}

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16);
        crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, derivedKey) => {
            if (error) return reject(error);
            resolve(`scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`);
        });
    });
}

function verifyPassword(password, stored) {
    return new Promise((resolve, reject) => {
        const parts = String(stored || "").split(":");
        if (parts.length !== 3 || parts[0] !== "scrypt") return resolve(false);
        const salt = Buffer.from(parts[1], "hex");
        const expected = Buffer.from(parts[2], "hex");
        crypto.scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1 }, (error, derivedKey) => {
            if (error) return reject(error);
            resolve(derivedKey.length === expected.length && crypto.timingSafeEqual(derivedKey, expected));
        });
    });
}

function cleanUsername(value) {
    return String(value || "").trim().slice(0, 30);
}

async function ensureAuthTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(30) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name VARCHAR(80),
            simbrief_username VARCHAR(80),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_simbrief_username_unique
        ON users (LOWER(simbrief_username))
        WHERE simbrief_username IS NOT NULL AND simbrief_username <> ''
    `);
}

function installAuth(app) {
    // This parser is deliberately installed before the auth routes because this module
    // is preloaded before server.js registers its normal middleware.
    app.use(express.json({ limit: "100kb" }));

    app.post("/api/auth/register", async (req, res) => {
        try {
            const username = cleanUsername(req.body?.username).toLowerCase();
            const displayName = String(req.body?.displayName || username).trim().slice(0, 80);
            const password = String(req.body?.password || "");

            if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
                return res.status(400).json({ error: "Username must be 3-30 characters and use letters, numbers, dot, underscore or hyphen." });
            }
            if (password.length < 8 || password.length > 200) {
                return res.status(400).json({ error: "Password must be at least 8 characters." });
            }

            const existing = await pool.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1", [username]);
            if (existing.rows.length) return res.status(409).json({ error: "That username is already in use." });

            const passwordHash = await hashPassword(password);
            const result = await pool.query(
                `INSERT INTO users (username, password_hash, display_name)
                 VALUES ($1, $2, $3)
                 RETURNING id, username, display_name, simbrief_username, created_at`,
                [username, passwordHash, displayName || username]
            );

            const user = result.rows[0];
            return res.status(201).json({
                user: {
                    id: user.id,
                    username: user.username,
                    displayName: user.display_name,
                    simbriefUsername: user.simbrief_username
                },
                token: signToken(user.id)
            });
        } catch (error) {
            console.error("Register error:", error);
            return res.status(500).json({ error: "Could not create account." });
        }
    });

    app.post("/api/auth/login", async (req, res) => {
        try {
            const username = cleanUsername(req.body?.username).toLowerCase();
            const password = String(req.body?.password || "");
            const result = await pool.query("SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1", [username]);
            if (!result.rows.length) return res.status(401).json({ error: "Invalid username or password." });

            const user = result.rows[0];
            const valid = await verifyPassword(password, user.password_hash);
            if (!valid) return res.status(401).json({ error: "Invalid username or password." });

            return res.json({
                user: {
                    id: user.id,
                    username: user.username,
                    displayName: user.display_name,
                    simbriefUsername: user.simbrief_username
                },
                token: signToken(user.id)
            });
        } catch (error) {
            console.error("Login error:", error);
            return res.status(500).json({ error: "Could not sign in." });
        }
    });

    app.post("/api/auth/me", async (req, res) => {
        try {
            const payload = verifyToken(req.body?.token);
            if (!payload) return res.status(401).json({ error: "Not authenticated." });

            const result = await pool.query(
                "SELECT id, username, display_name, simbrief_username, created_at FROM users WHERE id = $1 LIMIT 1",
                [payload.sub]
            );
            if (!result.rows.length) return res.status(401).json({ error: "Account no longer exists." });

            const user = result.rows[0];
            return res.json({
                user: {
                    id: user.id,
                    username: user.username,
                    displayName: user.display_name,
                    simbriefUsername: user.simbrief_username,
                    createdAt: user.created_at
                }
            });
        } catch (error) {
            console.error("Auth session error:", error);
            return res.status(500).json({ error: "Could not load account." });
        }
    });

    app.post("/api/auth/logout", (req, res) => {
        // Tokens are stateless and are removed from the browser by the client.
        return res.json({ success: true });
    });

    app.get("/api/simbrief/link", async (req, res) => {
        try {
            const payload = verifyToken(req.query?.token);
            if (!payload) return res.status(401).json({ error: "Not authenticated." });
            const result = await pool.query("SELECT username, simbrief_username FROM users WHERE id = $1", [payload.sub]);
            if (!result.rows.length) return res.status(401).json({ error: "Account no longer exists." });
            return res.json({
                connected: Boolean(result.rows[0].simbrief_username),
                simbriefUsername: result.rows[0].simbrief_username || null
            });
        } catch (error) {
            console.error("SimBrief status error:", error);
            return res.status(500).json({ error: "Could not load SimBrief connection." });
        }
    });

    app.post("/api/simbrief/link", async (req, res) => {
        try {
            const payload = verifyToken(req.body?.token);
            if (!payload) return res.status(401).json({ error: "Not authenticated." });

            const simbriefUsername = String(req.body?.simbriefUsername || "").trim().slice(0, 80);
            if (!/^[A-Za-z0-9._-]{2,80}$/.test(simbriefUsername)) {
                return res.status(400).json({ error: "Enter a valid SimBrief username." });
            }

            const result = await pool.query(
                `UPDATE users SET simbrief_username = $1, updated_at = NOW()
                 WHERE id = $2
                 RETURNING username, simbrief_username`,
                [simbriefUsername, payload.sub]
            );
            if (!result.rows.length) return res.status(401).json({ error: "Account no longer exists." });
            return res.json({ connected: true, simbriefUsername: result.rows[0].simbrief_username });
        } catch (error) {
            if (error.code === "23505") return res.status(409).json({ error: "That SimBrief username is already linked to another Flight App account." });
            console.error("SimBrief link error:", error);
            return res.status(500).json({ error: "Could not link SimBrief account." });
        }
    });

    app.post("/api/simbrief/unlink", async (req, res) => {
        try {
            const payload = verifyToken(req.body?.token);
            if (!payload) return res.status(401).json({ error: "Not authenticated." });
            await pool.query("UPDATE users SET simbrief_username = NULL, updated_at = NOW() WHERE id = $1", [payload.sub]);
            return res.json({ connected: false });
        } catch (error) {
            console.error("SimBrief unlink error:", error);
            return res.status(500).json({ error: "Could not disconnect SimBrief." });
        }
    });

    ensureAuthTables()
        .then(() => console.log("Flight App account system ready."))
        .catch(error => console.error("Could not initialize account system:", error));
}

function wrappedExpress(...args) {
    const app = originalExpress(...args);
    installAuth(app);
    return app;
}

Object.assign(wrappedExpress, originalExpress);
wrappedExpress.Router = originalExpress.Router;
wrappedExpress.json = originalExpress.json;
wrappedExpress.urlencoded = originalExpress.urlencoded;
wrappedExpress.static = originalExpress.static;

require.cache[require.resolve("express")].exports = wrappedExpress;
