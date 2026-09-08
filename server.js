const express = require("express");
const cors = require("cors");
const https = require("https");
const { Pool } = require("pg");

require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;

/*
|--------------------------------------------------------------------------
| DATABASE
|--------------------------------------------------------------------------
*/

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

/*
|--------------------------------------------------------------------------
| MIDDLEWARE
|--------------------------------------------------------------------------
*/

app.use(cors());

app.use(express.json());

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function validICAO(icao) {
    return /^[A-Z]{4}$/.test(icao);
}

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(
            url,
            {
                headers: {
                    "User-Agent":
                        "Flight-App/1.0 (flight simulator companion application)",
                    Accept: "application/json"
                }
            },
            response => {
                let data = "";

                response.on("data", chunk => {
                    data += chunk;
                });

                response.on("end", () => {
                    if (
                        response.statusCode < 200 ||
                        response.statusCode >= 300
                    ) {
                        reject(
                            new Error(
                                `External API returned HTTP ${response.statusCode}`
                            )
                        );

                        return;
                    }

                    try {
                        resolve(JSON.parse(data));
                    } catch (error) {
                        reject(
                            new Error(
                                "External API returned invalid JSON"
                            )
                        );
                    }
                });
            }
        );

        request.on("error", reject);

        request.setTimeout(15000, () => {
            request.destroy();

            reject(
                new Error("External API request timed out")
            );
        });
    });
}

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get("/api/health", async (req, res) => {
    let database = "Unavailable";

    try {
        await pool.query("SELECT 1");

        database = "Connected";
    } catch (error) {
        console.error(
            "Database health check failed:",
            error.message
        );
    }

    res.json({
        status: "ok",
        service: "Flight-app backend",
        database,
        timestamp: new Date().toISOString()
    });
});

/*
|--------------------------------------------------------------------------
| DATABASE TEST
|--------------------------------------------------------------------------
*/

app.get("/api/database/test", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT NOW() AS server_time"
        );

        res.json({
            available: true,
            database: "Connected",
            serverTime: result.rows[0].server_time
        });
    } catch (error) {
        console.error(
            "Database test failed:",
            error.message
        );

        res.status(503).json({
            available: false,
            database: "Unavailable"
        });
    }
});

/*
|--------------------------------------------------------------------------
| SIMBRIEF - LATEST OFP
|--------------------------------------------------------------------------
*/

app.get("/api/simbrief/latest", async (req, res) => {
    const username = String(
        req.query.username || ""
    ).trim();

    /*
    |--------------------------------------------------------------------------
    | VALIDATE USERNAME
    |--------------------------------------------------------------------------
    */

    if (!username) {
        return res.status(400).json({
            available: false,
            error: "SimBrief username is required."
        });
    }

    if (username.length > 80) {
        return res.status(400).json({
            available: false,
            error: "Invalid SimBrief username."
        });
    }

    /*
    |--------------------------------------------------------------------------
    | BASIC USERNAME VALIDATION
    |--------------------------------------------------------------------------
    */

    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
        return res.status(400).json({
            available: false,
            error: "Invalid SimBrief username."
        });
    }

    try {
        /*
        |--------------------------------------------------------------------------
        | SIMBRIEF API
        |--------------------------------------------------------------------------
        */

        const url =
            "https://www.simbrief.com/api/xml.fetcher.php" +
            `?username=${encodeURIComponent(username)}` +
            "&json=v2";

        console.log(
            `Fetching latest SimBrief OFP for: ${username}`
        );

        const data = await fetchJSON(url);

        /*
        |--------------------------------------------------------------------------
        | CHECK RESPONSE
        |--------------------------------------------------------------------------
        */

        if (!data || typeof data !== "object") {
            return res.status(502).json({
                available: false,
                error:
                    "SimBrief returned an empty or invalid response."
            });
        }

        /*
        |--------------------------------------------------------------------------
        | RETURN OFP
        |--------------------------------------------------------------------------
        */

        return res.json({
            available: true,
            source: "SimBrief",
            username,
            ofp: data
        });

    } catch (error) {
        console.error(
            "SimBrief OFP fetch failed:",
            error.message
        );

        return res.status(502).json({
            available: false,
            error:
                "SimBrief did not return a valid latest OFP."
        });
    }
});

/*
|--------------------------------------------------------------------------
| WEATHER - METAR
|--------------------------------------------------------------------------
*/

app.get("/api/weather/:icao", async (req, res) => {
    const icao = req.params.icao
        .toUpperCase()
        .trim();

    if (!validICAO(icao)) {
        return res.status(400).json({
            available: false,
            icao,
            message: "Invalid ICAO code"
        });
    }

    try {
        const url =
            `https://aviationweather.gov/api/data/metar` +
            `?ids=${encodeURIComponent(icao)}` +
            `&format=json`;

        const data = await fetchJSON(url);

        if (!Array.isArray(data) || data.length === 0) {
            return res.json({
                available: false,
                icao,
                message: "Unavailable"
            });
        }

        const metar = data[0];

        /*
        |--------------------------------------------------------------------------
        | CACHE WEATHER IN NEON
        |--------------------------------------------------------------------------
        */

        try {
            await pool.query(
                `
                INSERT INTO weather_cache
                (
                    icao,
                    metar,
                    raw_metar,
                    fetched_at
                )
                VALUES
                ($1, $2, $3, NOW())
                `,
                [
                    icao,
                    metar.rawOb ||
                        metar.raw_text ||
                        null,
                    JSON.stringify(metar)
                ]
            );
        } catch (databaseError) {
            console.error(
                "Could not cache METAR:",
                databaseError.message
            );
        }

        res.json({
            available: true,
            icao,
            metar
        });
    } catch (error) {
        console.error(
            "METAR request failed:",
            error.message
        );

        res.status(502).json({
            available: false,
            icao,
            message: "Unavailable"
        });
    }
});

/*
|--------------------------------------------------------------------------
| WEATHER - TAF
|--------------------------------------------------------------------------
*/

app.get("/api/weather/:icao/taf", async (req, res) => {
    const icao = req.params.icao
        .toUpperCase()
        .trim();

    if (!validICAO(icao)) {
        return res.status(400).json({
            available: false,
            icao,
            message: "Invalid ICAO code"
        });
    }

    try {
        const url =
            `https://aviationweather.gov/api/data/taf` +
            `?ids=${encodeURIComponent(icao)}` +
            `&format=json`;

        const data = await fetchJSON(url);

        if (!Array.isArray(data) || data.length === 0) {
            return res.json({
                available: false,
                icao,
                message: "Unavailable"
            });
        }

        const taf = data[0];

        /*
        |--------------------------------------------------------------------------
        | CACHE TAF
        |--------------------------------------------------------------------------
        */

        try {
            await pool.query(
                `
                INSERT INTO weather_cache
                (
                    icao,
                    taf,
                    raw_taf,
                    fetched_at
                )
                VALUES
                ($1, $2, $3, NOW())
                `,
                [
                    icao,
                    taf.rawTAF ||
                        taf.raw_text ||
                        null,
                    JSON.stringify(taf)
                ]
            );
        } catch (databaseError) {
            console.error(
                "Could not cache TAF:",
                databaseError.message
            );
        }

        res.json({
            available: true,
            icao,
            taf
        });
    } catch (error) {
        console.error(
            "TAF request failed:",
            error.message
        );

        res.status(502).json({
            available: false,
            icao,
            message: "Unavailable"
        });
    }
});

/*
|--------------------------------------------------------------------------
| CACHED WEATHER
|--------------------------------------------------------------------------
*/

app.get("/api/weather/:icao/cache", async (req, res) => {
    const icao = req.params.icao
        .toUpperCase()
        .trim();

    if (!validICAO(icao)) {
        return res.status(400).json({
            available: false,
            message: "Invalid ICAO code"
        });
    }

    try {
        const result = await pool.query(
            `
            SELECT
                icao,
                metar,
                taf,
                raw_metar,
                raw_taf,
                fetched_at
            FROM weather_cache
            WHERE icao = $1
            ORDER BY fetched_at DESC
            LIMIT 1
            `,
            [icao]
        );

        if (result.rows.length === 0) {
            return res.json({
                available: false,
                icao,
                message: "No cached data available"
            });
        }

        res.json({
            available: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error(
            "Cached weather lookup failed:",
            error.message
        );

        res.status(503).json({
            available: false,
            message: "Unavailable"
        });
    }
});

/*
|--------------------------------------------------------------------------
| AIRPORT INFORMATION
|--------------------------------------------------------------------------
*/

app.get("/api/airports/:icao", async (req, res) => {

    const icao = req.params.icao
        .toUpperCase()
        .trim();

    if (!validICAO(icao)) {
        return res.status(400).json({
            available: false,
            message: "Invalid ICAO code"
        });
    }

    try {

        /*
        |--------------------------------------------------------------------------
        | FIRST: CHECK AIRPORT CACHE
        |--------------------------------------------------------------------------
        */

        const airportResult = await pool.query(
            `
            SELECT
                icao,
                name,
                iata,
                latitude,
                longitude,
                elevation_ft,
                country,
                city,
                raw_data,
                updated_at
            FROM airport_cache
            WHERE icao = $1
            LIMIT 1
            `,
            [icao]
        );

        if (airportResult.rows.length > 0) {

            return res.json({
                available: true,
                airport: airportResult.rows[0]
            });

        }

        /*
        |--------------------------------------------------------------------------
        | FALLBACK: USE LATEST METAR DATA
        |--------------------------------------------------------------------------
        */

        const weatherResult = await pool.query(
            `
            SELECT
                raw_metar,
                fetched_at
            FROM weather_cache
            WHERE icao = $1
              AND raw_metar IS NOT NULL
            ORDER BY fetched_at DESC
            LIMIT 1
            `,
            [icao]
        );

        if (weatherResult.rows.length === 0) {

            return res.json({
                available: false,
                icao,
                message: "Unavailable"
            });

        }

        let metarData;

        try {

            metarData =
                typeof weatherResult.rows[0].raw_metar === "string"
                    ? JSON.parse(weatherResult.rows[0].raw_metar)
                    : weatherResult.rows[0].raw_metar;

        } catch (parseError) {

            console.error(
                "Could not parse cached METAR:",
                parseError.message
            );

            return res.json({
                available: false,
                icao,
                message: "Unavailable"
            });

        }

        /*
        |--------------------------------------------------------------------------
        | BUILD AIRPORT OBJECT
        |--------------------------------------------------------------------------
        */

        const airport = {

            icao:
                metarData.icaoId ||
                icao,

            name:
                metarData.name ||
                "--",

            iata:
                metarData.iata ||
                null,

            latitude:
                metarData.lat != null
                    ? metarData.lat
                    : null,

            longitude:
                metarData.lon != null
                    ? metarData.lon
                    : null,

            elevation_ft:
                metarData.elev != null
                    ? metarData.elev
                    : null,

            country:
                null,

            city:
                null,

            raw_data:
                metarData,

            updated_at:
                weatherResult.rows[0].fetched_at

        };

        /*
        |--------------------------------------------------------------------------
        | RETURN AIRPORT INFORMATION
        |--------------------------------------------------------------------------
        */

        return res.json({
            available: true,
            airport
        });

    } catch (error) {

        console.error(
            "Airport information lookup failed:",
            error.message
        );

        return res.status(503).json({
            available: false,
            icao,
            message: "Unavailable"
        });

    }

});

/*
|--------------------------------------------------------------------------
| SAVED PLANS
|--------------------------------------------------------------------------
*/

app.get("/api/plans", async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT *
            FROM saved_plans
            ORDER BY created_at DESC
            `
        );

        res.json({
            available: true,
            plans: result.rows
        });
    } catch (error) {
        console.error(
            "Plans lookup failed:",
            error.message
        );

        res.status(503).json({
            available: false,
            plans: []
        });
    }
});

/*
|--------------------------------------------------------------------------
| CREATE SAVED PLAN
|--------------------------------------------------------------------------
*/

app.post("/api/plans", async (req, res) => {

    const {
        name,
        departure_icao,
        arrival_icao,
        aircraft_icao,
        cruise_altitude,
        route,
        distance_nm,
        estimated_minutes,
        simbrief_ofp_id
    } = req.body;

    /*
    |--------------------------------------------------------------------------
    | VALIDATION
    |--------------------------------------------------------------------------
    */

    if (
        !name ||
        String(name).trim() === ""
    ) {
        return res.status(400).json({
            available: false,
            error: "Plan name is required"
        });
    }

    if (
        departure_icao &&
        !validICAO(
            String(departure_icao)
                .toUpperCase()
                .trim()
        )
    ) {
        return res.status(400).json({
            available: false,
            error: "Invalid departure ICAO"
        });
    }

    if (
        arrival_icao &&
        !validICAO(
            String(arrival_icao)
                .toUpperCase()
                .trim()
        )
    ) {
        return res.status(400).json({
            available: false,
            error: "Invalid arrival ICAO"
        });
    }

    try {

        /*
        |--------------------------------------------------------------------------
        | INSERT PLAN
        |--------------------------------------------------------------------------
        */

        const result = await pool.query(
            `
            INSERT INTO saved_plans
            (
                name,
                departure_icao,
                arrival_icao,
                aircraft_icao,
                cruise_altitude,
                route,
                distance_nm,
                estimated_minutes,
                simbrief_ofp_id
            )
            VALUES
            (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9
            )
            RETURNING *
            `,
            [
                String(name).trim(),

                departure_icao
                    ? String(departure_icao)
                        .toUpperCase()
                        .trim()
                    : null,

                arrival_icao
                    ? String(arrival_icao)
                        .toUpperCase()
                        .trim()
                    : null,

                aircraft_icao
                    ? String(aircraft_icao)
                        .toUpperCase()
                        .trim()
                    : null,

                cruise_altitude
                    ? Number(cruise_altitude)
                    : null,

                route
                    ? String(route).trim()
                    : null,

                distance_nm
                    ? Number(distance_nm)
                    : null,

                estimated_minutes
                    ? Number(estimated_minutes)
                    : null,

                simbrief_ofp_id
                    ? String(simbrief_ofp_id).trim()
                    : null
            ]
        );

        return res.status(201).json({
            available: true,
            plan: result.rows[0]
        });

    } catch (error) {

        console.error(
            "Could not save plan:",
            error.message
        );

        return res.status(500).json({
            available: false,
            error: "Could not save plan"
        });
    }
});

/*
|--------------------------------------------------------------------------
| DELETE SAVED PLAN
|--------------------------------------------------------------------------
*/

app.delete("/api/plans/:id", async (req, res) => {

    const id =
        Number(req.params.id);

    if (!Number.isInteger(id)) {
        return res.status(400).json({
            available: false,
            error: "Invalid plan ID"
        });
    }

    try {

        const result = await pool.query(
            `
            DELETE FROM saved_plans
            WHERE id = $1
            RETURNING id
            `,
            [id]
        );

        if (result.rows.length === 0) {

            return res.status(404).json({
                available: false,
                error: "Plan not found"
            });

        }

        return res.json({
            available: true,
            deleted: true,
            id
        });

    } catch (error) {

        console.error(
            "Could not delete plan:",
            error.message
        );

        return res.status(500).json({
            available: false,
            error: "Could not delete plan"
        });
    }
});

/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get("/", async (req, res) => {

    let database =
        "Unavailable";

    try {

        await pool.query("SELECT 1");

        database =
            "Connected";

    } catch (error) {

        console.error(
            "Root database check failed:",
            error.message
        );

    }

    res.json({

        service:
            "Flight-app API",

        status:
            "Online",

        database,

        version:
            "1.1.0",

        endpoints: {

            health:
                "/api/health",

            databaseTest:
                "/api/database/test",

            simbriefLatest:
                "/api/simbrief/latest?username=YOUR_USERNAME",

            weather:
                "/api/weather/:icao",

            taf:
                "/api/weather/:icao/taf",

            cachedWeather:
                "/api/weather/:icao/cache",

            airports:
                "/api/airports/:icao",

            plans:
                "/api/plans"

        }

    });

});

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use((req, res) => {

    res.status(404).json({

        available: false,

        error:
            "Endpoint not found"

    });

});

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use(
    (error, req, res, next) => {

        console.error(
            "Unhandled server error:",
            error
        );

        res.status(500).json({

            available: false,

            error:
                "Internal server error"

        });

    }
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

async function startServer() {

    try {

        await pool.query(
            "SELECT 1"
        );

        console.log(
            "Successfully connected to Neon PostgreSQL."
        );

        app.listen(
            PORT,
            () => {

                console.log(
                    `Flight-app backend running on port ${PORT}`
                );

            }
        );

    } catch (error) {

        console.error(
            "Could not connect to Neon:",
            error.message
        );

        process.exit(1);

    }

}

startServer();

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
*/

process.on(
    "SIGTERM",
    async () => {

        console.log(
            "SIGTERM received."
        );

        await pool.end();

        process.exit(0);

    }
);

process.on(
    "SIGINT",
    async () => {

        console.log(
            "SIGINT received."
        );

        await pool.end();

        process.exit(0);

    }
);
