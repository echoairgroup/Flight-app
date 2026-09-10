const crypto = require("crypto");

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_KEYLEN = 64;
const PASSWORD_SALT_BYTES = 16;
const TOKEN_BYTES = 32;

function normalizeUsername(value) {
    return String(value || "").trim().toLowerCase();
}

function validUsername(value) {
    return /^[a-z0-9_]{3,30}$/.test(value);
}

function hashPassword(password) {
    const salt = crypto.randomBytes(PASSWORD_SALT_BYTES).toString("hex");
    const hash = crypto.scryptSync(password, salt, PASSWORD_KEYLEN).toString("hex");
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    const [salt, expected] = String(stored || "").split(":");
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(password, salt, PASSWORD_KEYLEN).toString("hex");
    const a = Buffer.from(actual, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenSecret() {
    if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
        throw new Error("AUTH_SECRET must be configured and at least 32 characters long.");
    }
    return process.env.AUTH_SECRET;
}

function createToken(userId) {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: String(userId), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS })).toString("base64url");
    const data = `${header}.${payload}`;
    const signature = crypto.createHmac("sha256", tokenSecret()).update(data).digest("base64url");
    return `${data}.${signature}`;
}

function verifyToken(token) {
    try {
        const parts = String(token || "").split(".");
        if (parts.length !== 3) return null;
        const [header, payload, signature] = parts;
        const data = `${header}.${payload}`;
        const expected = crypto.createHmac("sha256", tokenSecret()).update(data).digest("base64url");
        const a = Buffer.from(signature);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!decoded.sub || !decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
        return decoded;
    } catch {
        return null;
    }
}

async function ensureAuthTables(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(30) NOT NULL UNIQUE,
            display_name VARCHAR(80) NOT NULL,
            password_hash TEXT NOT NULL,
            simbrief_username VARCHAR(80) UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

function userPublic(user) {
    return {
        id: String(user.id),
        username: user.username,
        displayName: user.display_name,
        simbriefUsername: user.simbrief_username || null,
        createdAt: user.created_at
    };
}

function createAuthRoutes(app, pool) {
    app.post("/api/auth/register", async (req, res) => {
        try {
            const username = normalizeUsername(req.body?.username);
            const displayName = String(req.body?.displayName || username).trim().slice(0, 80);
            const password = String(req.body?.password || "");

            if (!validUsername(username)) {
                return res.status(400).json({ error: "Username must be 3–30 characters and use only letters, numbers or underscores." });
            }
            if (password.length < 8 || password.length > 200) {
                return res.status(400).json({ error: "Password must be between 8 and 200 characters." });
            }
            if (!displayName) {
                return res.status(400).json({ error: "Display name is required." });
            }

            const existing = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
            if (existing.rowCount) {
                return res.status(409).json({ error: "That username is already in use." });
            }

            const passwordHash = hashPassword(password);
            const result = await pool.query(
                `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id, username, display_name, simbrief_username, created_at`,
                [username, displayName, passwordHash]
            );

            const user = result.rows[0];
            return res.status(201).json({ token: createToken(user.id), user: userPublic(user) });
        } catch (error) {
            console.error("Registration error:", error);
            return res.status(500).json({ error: "Could not create the account." });
        }
    });

    app.post("/api/auth/login", async (req, res) => {
        try {
            const username = normalizeUsername(req.body?.username);
            const password = String(req.body?.password || "");
            const result = await pool.query("SELECT id, username, display_name, password_hash, simbrief_username, created_at FROM users WHERE username = $1", [username]);
            if (!result.rowCount || !verifyPassword(password, result.rows[0].password_hash)) {
                return res.status(401).json({ error: "Invalid username or password." });
            }
            const user = result.rows[0];
            return res.json({ token: createToken(user.id), user: userPublic(user) });
        } catch (error) {
            console.error("Login error:", error);
            return res.status(500).json({ error: "Could not sign in." });
        }
    });

    app.get("/api/auth/me", requireAuth(pool), async (req, res) => {
        res.json({ user: userPublic(req.user) });
    });

    app.get("/api/account/simbrief", requireAuth(pool), async (req, res) => {
        res.json({ connected: Boolean(req.user.simbrief_username), username: req.user.simbrief_username || null });
    });

    app.put("/api/account/simbrief", requireAuth(pool), async (req, res) => {
        try {
            const username = String(req.body?.username || "").trim();
            if (!username || username.length > 80 || !/^[A-Za-z0-9_.-]+$/.test(username)) {
                return res.status(400).json({ error: "Enter a valid SimBrief username." });
            }
            const result = await pool.query(
                "UPDATE users SET simbrief_username = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, display_name, simbrief_username, created_at",
                [username, req.user.id]
            );
            return res.json({ user: userPublic(result.rows[0]) });
        } catch (error) {
            if (error.code === "23505") return res.status(409).json({ error: "That SimBrief username is already linked to another Flight App account." });
            console.error("SimBrief link error:", error);
            return res.status(500).json({ error: "Could not link SimBrief." });
        }
    });

    app.delete("/api/account/simbrief", requireAuth(pool), async (req, res) => {
        try {
            const result = await pool.query(
                "UPDATE users SET simbrief_username = NULL, updated_at = NOW() WHERE id = $1 RETURNING id, username, display_name, simbrief_username, created_at",
                [req.user.id]
            );
            res.json({ user: userPublic(result.rows[0]) });
        } catch (error) {
            console.error("SimBrief unlink error:", error);
            res.status(500).json({ error: "Could not disconnect SimBrief." });
        }
    });
}

function requireAuth(pool) {
    return async (req, res, next) => {
        try {
            const auth = String(req.headers.authorization || "");
            if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required." });
            const payload = verifyToken(auth.slice(7));
            if (!payload) return res.status(401).json({ error: "Your session is invalid or expired." });
            const result = await pool.query("SELECT id, username, display_name, simbrief_username, created_at FROM users WHERE id = $1", [payload.sub]);
            if (!result.rowCount) return res.status(401).json({ error: "Account not found." });
            req.user = result.rows[0];
            next();
        } catch (error) {
            console.error("Authentication error:", error);
            res.status(500).json({ error: "Authentication service unavailable." });
        }
    };
}

module.exports = { ensureAuthTables, createAuthRoutes, requireAuth, createToken, verifyToken, TOKEN_BYTES };
