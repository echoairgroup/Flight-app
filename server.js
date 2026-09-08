const express = require("express");
const cors = require("cors");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const VERSION = "3.0.0";

/*
|--------------------------------------------------------------------------
| Current LVNL AIRAC
|--------------------------------------------------------------------------
|
| We keep this configurable so we can update it when LVNL publishes
| a new AIRAC cycle.
|
*/

const LVNL_AIRAC =
    process.env.LVNL_AIRAC ||
    "AIRAC%20AMDT%2008-2026_2026_08_06";

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.use(cors());

app.use(express.json());

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function normalizeICAO(icao) {

    return String(icao || "")
        .trim()
        .toUpperCase();

}

function validICAO(icao) {

    return /^[A-Z0-9]{4}$/.test(icao);

}

/*
|--------------------------------------------------------------------------
| Chart configuration
|--------------------------------------------------------------------------
*/

const CHART_TYPES = {

    ADC: {
        name: "Aerodrome Chart",
        code: "ADC"
    },

    APDC: {
        name: "Aircraft Parking / Docking Chart",
        code: "APDC"
    },

    GMC: {
        name: "Ground Movement Chart",
        code: "GMC"
    },

    AOC: {
        name: "Aerodrome Obstacle Chart",
        code: "AOC"
    },

    PATC: {
        name: "Precision Approach Terrain Chart",
        code: "PATC"
    },

    SID: {
        name: "Standard Instrument Departure",
        code: "SID"
    },

    STAR: {
        name: "Standard Arrival Chart",
        code: "STAR"
    },

    IAC: {
        name: "Instrument Approach Chart",
        code: "IAC"
    },

    VAC: {
        name: "Visual Approach Chart",
        code: "VAC"
    }

};

/*
|--------------------------------------------------------------------------
| Build LVNL chart URL
|--------------------------------------------------------------------------
*/

function buildLVNLChartURL(icao, type) {

    return (
        `https://eaip.lvnl.nl/web/eaip/` +
        `${LVNL_AIRAC}/documents/Root_WePub/Charts/AD/` +
        `${icao}/${icao}-${type}.pdf`
    );

}

/*
|--------------------------------------------------------------------------
| Root
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {

    res.json({

        service:
            "Echo Flight App - Free Charts API",

        version: VERSION,

        online: true,

        provider: "LVNL",

        coverage: "Netherlands"

    });

});

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get("/health", (req, res) => {

    res.json({

        status: "ok",

        online: true,

        version: VERSION,

        provider: "LVNL"

    });

});

/*
|--------------------------------------------------------------------------
| Status
|--------------------------------------------------------------------------
*/

app.get("/api/status", (req, res) => {

    res.json({

        available: true,

        bridge: {

            online: true,

            name:
                "Echo Flight App - Free Charts API",

            version: VERSION

        },

        provider: {

            name: "LVNL",

            country: "Netherlands",

            airac: LVNL_AIRAC

        }

    });

});

/*
|--------------------------------------------------------------------------
| Get available chart categories
|--------------------------------------------------------------------------
*/

app.get("/api/charts/:icao", (req, res) => {

    const icao =
        normalizeICAO(req.params.icao);

    if (!validICAO(icao)) {

        return res.status(400).json({

            error: "Invalid ICAO code.",

            example: "EHAM"

        });

    }

    const charts =
        Object.values(CHART_TYPES)
            .map(chart => ({

                type: chart.code,

                name: chart.name,

                url:
                    buildLVNLChartURL(
                        icao,
                        chart.code
                    )

            }));

    res.json({

        icao,

        provider: "LVNL",

        airac: LVNL_AIRAC,

        charts

    });

});

/*
|--------------------------------------------------------------------------
| Get a specific chart
|--------------------------------------------------------------------------
|
| Example:
|
| /api/charts/EHAM/GMC
|
*/

app.get(
    "/api/charts/:icao/:type",
    (req, res) => {

        const icao =
            normalizeICAO(req.params.icao);

        const type =
            String(req.params.type || "")
                .trim()
                .toUpperCase();

        if (!validICAO(icao)) {

            return res.status(400).json({

                error: "Invalid ICAO code.",

                example: "EHAM"

            });

        }

        if (!CHART_TYPES[type]) {

            return res.status(400).json({

                error:
                    "Unknown chart type.",

                allowed:
                    Object.keys(CHART_TYPES)

            });

        }

        const chart =
            CHART_TYPES[type];

        res.json({

            icao,

            type,

            name: chart.name,

            provider: "LVNL",

            airac: LVNL_AIRAC,

            url:
                buildLVNLChartURL(
                    icao,
                    type
                )

        });

    }
);

/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

app.listen(
    PORT,
    HOST,
    () => {

        console.log(
            `Echo Charts API running on ${HOST}:${PORT}`
        );

        console.log(
            `LVNL AIRAC: ${LVNL_AIRAC}`
        );

    }
);
