const express = require("express");
const cors = require("cors");
const https = require("https");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(
            url,
            {
                headers: {
                    "User-Agent": "Flight-App/1.0"
                }
            },
            response => {
                let data = "";

                response.on("data", chunk => {
                    data += chunk;
                });

                response.on("end", () => {
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(
                            new Error(
                                `External API returned HTTP ${response.statusCode}`
                            )
                        );
                        return;
                    }

                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error("Invalid JSON response"));
                    }
                });
            }
        ).on("error", reject);
    });
}


/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        service: "Flight-app backend",
        timestamp: new Date().toISOString()
    });
});


/*
|--------------------------------------------------------------------------
| LIVE METAR
|--------------------------------------------------------------------------
|
| Example:
| /api/weather/EHAM
|
*/

app.get("/api/weather/:icao", async (req, res) => {
    const icao = req.params.icao.toUpperCase().trim();

    if (!/^[A-Z]{4}$/.test(icao)) {
        return res.status(400).json({
            available: false,
            error: "Invalid ICAO code"
        });
    }

    try {
        const url =
            `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`;

        const data = await fetchJSON(url);

        if (!Array.isArray(data) || data.length === 0) {
            return res.json({
                available: false,
                icao,
                message: "Unavailable"
            });
        }

        const metar = data[0];

        res.json({
            available: true,
            icao,
            metar
        });

    } catch (error) {
        console.error("Weather API error:", error.message);

        res.status(502).json({
            available: false,
            icao,
            message: "Unavailable"
        });
    }
});


/*
|--------------------------------------------------------------------------
| LIVE TAF
|--------------------------------------------------------------------------
|
| Example:
| /api/weather/EHAM/taf
|
*/

app.get("/api/weather/:icao/taf", async (req, res) => {
    const icao = req.params.icao.toUpperCase().trim();

    if (!/^[A-Z]{4}$/.test(icao)) {
        return res.status(400).json({
            available: false,
            error: "Invalid ICAO code"
        });
    }

    try {
        const url =
            `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`;

        const data = await fetchJSON(url);

        if (!Array.isArray(data) || data.length === 0) {
            return res.json({
                available: false,
                icao,
                message: "Unavailable"
            });
        }

        res.json({
            available: true,
            icao,
            taf: data[0]
        });

    } catch (error) {
        console.error("TAF API error:", error.message);

        res.status(502).json({
            available: false,
            icao,
            message: "Unavailable"
        });
    }
});


/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use((err, req, res, next) => {
    console.error(err);

    res.status(500).json({
        available: false,
        error: "Internal server error"
    });
});


/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

app.listen(PORT, () => {
    console.log(
        `Flight-app backend running on port ${PORT}`
    );
});
