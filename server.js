const express = require("express");
const cors = require("cors");
const https = require("https");
const zlib = require("zlib");
const multer = require("multer");
const { Pool } = require("pg");

require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;

const API_VERSION = "1.4.0";

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

app.use(
    cors({
        origin: true,
        methods: [
            "GET",
            "POST",
            "DELETE",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Accept"
        ]
    })
);

app.use(
    express.json({
        limit: "5mb"
    })
);

/*
|--------------------------------------------------------------------------
| PUBLIC BASE URL
|--------------------------------------------------------------------------
|
| Render normally provides RENDER_EXTERNAL_URL.
| If that is unavailable, requests are used to construct URLs.
|
|--------------------------------------------------------------------------
*/

function getBaseUrl(req) {

    if (
        process.env.PUBLIC_BASE_URL
    ) {
        return process.env.PUBLIC_BASE_URL
            .replace(/\/+$/, "");
    }

    if (
        process.env.RENDER_EXTERNAL_URL
    ) {
        return process.env.RENDER_EXTERNAL_URL
            .replace(/\/+$/, "");
    }

    const protocol =
        req.headers["x-forwarded-proto"] ||
        req.protocol ||
        "https";

    const host =
        req.get("host");

    return `${protocol}://${host}`;
}

/*
|--------------------------------------------------------------------------
| IMAGE UPLOAD CONFIGURATION
|--------------------------------------------------------------------------
*/

const imageUpload = multer({

    storage:
        multer.memoryStorage(),

    limits: {
        fileSize:
            15 * 1024 * 1024
    },

    fileFilter:
        (req, file, callback) => {

            const allowedTypes = [
                "image/png",
                "image/jpeg",
                "image/webp"
            ];

            if (
                allowedTypes.includes(
                    file.mimetype
                )
            ) {

                callback(
                    null,
                    true
                );

            } else {

                callback(
                    new Error(
                        "Only PNG, JPG/JPEG and WebP images are allowed."
                    )
                );
            }
        }
});

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function validICAO(
    icao
) {

    return /^[A-Z]{4}$/.test(
        String(
            icao || ""
        )
            .trim()
            .toUpperCase()
    );
}

function cleanString(
    value,
    maxLength = 500
) {

    return String(
        value ?? ""
    )
        .trim()
        .slice(
            0,
            maxLength
        );
}

function parseJsonValue(
    value
) {

    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    if (
        typeof value === "object"
    ) {
        return value;
    }

    try {

        return JSON.parse(
            value
        );

    } catch {

        return null;
    }
}

/*
|--------------------------------------------------------------------------
| CHART VALIDATION
|--------------------------------------------------------------------------
*/

const VALID_CHART_TYPES = [
    "AIRPORT",
    "APPROACH",
    "SID",
    "STAR",
    "ENROUTE"
];

const VALID_CHART_PROVIDERS = [
    "LIDO",
    "FAA"
];

function validChartType(
    type
) {

    return VALID_CHART_TYPES.includes(
        String(
            type || ""
        )
            .trim()
            .toUpperCase()
    );
}

function validChartProvider(
    provider
) {

    return VALID_CHART_PROVIDERS.includes(
        String(
            provider || ""
        )
            .trim()
            .toUpperCase()
    );
}

/*
|--------------------------------------------------------------------------
| AIRCRAFT TYPE HELPERS
|--------------------------------------------------------------------------
*/

function validAircraftName(
    name
) {

    const value =
        cleanString(
            name,
            150
        );

    return (
        value.length >= 2 &&
        value.length <= 150
    );
}

function validAircraftCode(
    code
) {

    if (
        !code
    ) {
        return true;
    }

    return /^[A-Z0-9._-]{2,30}$/.test(
        String(code)
            .trim()
            .toUpperCase()
    );
}

/*
|--------------------------------------------------------------------------
| CHECKLIST HELPERS
|--------------------------------------------------------------------------
*/

const VALID_CHECKLIST_CATEGORIES = [
    "PREFLIGHT",
    "COCKPIT",
    "BEFORE_START",
    "START",
    "TAXI",
    "TAKEOFF",
    "CLIMB",
    "CRUISE",
    "DESCENT",
    "APPROACH",
    "LANDING",
    "SHUTDOWN",
    "EMERGENCY",
    "OTHER"
];

function normalizeChecklistCategory(
    category
) {

    const value =
        String(
            category ||
            "OTHER"
        )
            .trim()
            .toUpperCase();

    return VALID_CHECKLIST_CATEGORIES.includes(
        value
    )
        ? value
        : "OTHER";
}

/*
|--------------------------------------------------------------------------
| HTTPS JSON FETCH
|--------------------------------------------------------------------------
*/

function fetchJSON(
    url
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            const request =
                https.get(
                    url,
                    {
                        headers: {

                            "User-Agent":
                                "Flight-App/1.0 (flight simulator companion application)",

                            Accept:
                                "application/json",

                            "Accept-Encoding":
                                "identity"
                        }
                    },
                    response => {

                        let data =
                            "";

                        response.setEncoding(
                            "utf8"
                        );

                        response.on(
                            "data",
                            chunk => {

                                data +=
                                    chunk;
                            }
                        );

                        response.on(
                            "end",
                            () => {

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

                                if (
                                    response.statusCode === 204 ||
                                    !data.trim()
                                ) {

                                    resolve(
                                        []
                                    );

                                    return;
                                }

                                try {

                                    resolve(
                                        JSON.parse(
                                            data
                                        )
                                    );

                                } catch {

                                    reject(
                                        new Error(
                                            "External API returned invalid JSON"
                                        )
                                    );
                                }
                            }
                        );
                    }
                );

            request.on(
                "error",
                reject
            );

            request.setTimeout(
                15000,
                () => {

                    request.destroy();

                    reject(
                        new Error(
                            "External API request timed out"
                        )
                    );
                }
            );
        }
    );
}

/*
|--------------------------------------------------------------------------
| GZIP JSON FETCH
|--------------------------------------------------------------------------
*/

function fetchGzipJSON(
    url
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            const request =
                https.get(
                    url,
                    {
                        headers: {

                            "User-Agent":
                                "Flight-App/1.0 (flight simulator companion application)",

                            Accept:
                                "application/json"
                        }
                    },
                    response => {

                        if (
                            response.statusCode < 200 ||
                            response.statusCode >= 300
                        ) {

                            response.resume();

                            reject(
                                new Error(
                                    `External cache returned HTTP ${response.statusCode}`
                                )
                            );

                            return;
                        }

                        const gunzip =
                            zlib.createGunzip();

                        let output =
                            "";

                        response.pipe(
                            gunzip
                        );

                        gunzip.on(
                            "data",
                            chunk => {

                                output +=
                                    chunk.toString();
                            }
                        );

                        gunzip.on(
                            "end",
                            () => {

                                try {

                                    resolve(
                                        JSON.parse(
                                            output
                                        )
                                    );

                                } catch {

                                    reject(
                                        new Error(
                                            "Compressed cache returned invalid JSON"
                                        )
                                    );
                                }
                            }
                        );

                        gunzip.on(
                            "error",
                            reject
                        );
                    }
                );

            request.on(
                "error",
                reject
            );

            request.setTimeout(
                30000,
                () => {

                    request.destroy();

                    reject(
                        new Error(
                            "Compressed cache request timed out"
                        )
                    );
                }
            );
        }
    );
}

/*
|--------------------------------------------------------------------------
| AIRPORT CACHE
|--------------------------------------------------------------------------
*/

let airportStationsCache =
    null;

let airportStationsCacheUpdated =
    0;

const AIRPORT_STATIONS_CACHE_URL =
    "https://aviationweather.gov/data/cache/stations.cache.json.gz";

const AIRPORT_CACHE_MAX_AGE =
    24 *
    60 *
    60 *
    1000;

/*
|--------------------------------------------------------------------------
| AIRPORT NORMALIZER
|--------------------------------------------------------------------------
*/

function normalizeAirport(
    raw
) {

    if (
        !raw ||
        typeof raw !== "object"
    ) {
        return null;
    }

    const icao =
        String(
            raw.icaoId ??
            raw.icao ??
            raw.ident ??
            raw.icao_code ??
            raw.icaoCode ??
            raw.station_id ??
            raw.stationId ??
            raw.id ??
            ""
        )
            .trim()
            .toUpperCase();

    const iata =
        String(
            raw.iataId ??
            raw.iata ??
            raw.iata_code ??
            raw.iataCode ??
            ""
        )
            .trim()
            .toUpperCase();

    const name =
        String(
            raw.name ??
            raw.airport_name ??
            raw.airportName ??
            raw.facility_name ??
            raw.facilityName ??
            raw.site ??
            raw.station_name ??
            raw.stationName ??
            raw.location ??
            ""
        )
            .trim();

    const city =
        String(
            raw.city ??
            raw.municipality ??
            raw.municipalityName ??
            raw.town ??
            raw.locality ??
            raw.location_city ??
            ""
        )
            .trim();

    const country =
        String(
            raw.country ??
            raw.countryName ??
            raw.country_name ??
            raw.countryCode ??
            raw.country_code ??
            ""
        )
            .trim();

    const latitude =
        raw.lat ??
        raw.latitude ??
        raw.latDeg ??
        raw.latitudeDeg ??
        null;

    const longitude =
        raw.lon ??
        raw.lng ??
        raw.longitude ??
        raw.lonDeg ??
        null;

    const elevation =
        raw.elev ??
        raw.elevation ??
        raw.elevation_ft ??
        raw.elevationFt ??
        raw.altitude ??
        null;

    if (
        !icao &&
        !iata &&
        !name
    ) {

        return null;
    }

    return {

        icao:
            icao || null,

        iata:
            iata || null,

        name:
            name || null,

        city:
            city || null,

        country:
            country || null,

        latitude:
            latitude !== null &&
            latitude !== undefined &&
            latitude !== ""
                ? Number(latitude)
                : null,

        longitude:
            longitude !== null &&
            longitude !== undefined &&
            longitude !== ""
                ? Number(longitude)
                : null,

        elevation_ft:
            elevation !== null &&
            elevation !== undefined &&
            elevation !== ""
                ? Number(elevation)
                : null,

        raw_data:
            raw
    };
}

/*
|--------------------------------------------------------------------------
| EXTRACT AIRPORT ARRAY
|--------------------------------------------------------------------------
*/

function extractAirportArray(
    data
) {

    if (
        Array.isArray(
            data
        )
    ) {

        return data;
    }

    if (
        !data ||
        typeof data !== "object"
    ) {

        return [];
    }

    const possibleArrays = [
        data.airports,
        data.stations,
        data.features,
        data.data,
        data.results,
        data.items
    ];

    for (
        const value of possibleArrays
    ) {

        if (
            Array.isArray(
                value
            )
        ) {

            return value;
        }
    }

    if (
        Array.isArray(
            data.features
        )
    ) {

        return data.features.map(
            feature => {

                if (
                    feature &&
                    feature.properties
                ) {

                    return {

                        ...feature.properties,

                        latitude:
                            feature.geometry
                                ?.coordinates?.[1],

                        longitude:
                            feature.geometry
                                ?.coordinates?.[0]
                    };
                }

                return feature;
            }
        );
    }

    const values =
        Object.values(
            data
        );

    if (
        values.length > 0 &&
        values.some(
            value =>
                value &&
                typeof value ===
                    "object"
        )
    ) {

        return values;
    }

    return [];
}

/*
|--------------------------------------------------------------------------
| LOAD AIRPORT STATIONS
|--------------------------------------------------------------------------
*/

async function getAirportStations() {

    const now =
        Date.now();

    if (
        airportStationsCache &&
        now -
            airportStationsCacheUpdated <
            AIRPORT_CACHE_MAX_AGE
    ) {

        return airportStationsCache;
    }

    console.log(
        "Downloading AviationWeather airport/station cache..."
    );

    try {

        const raw =
            await fetchGzipJSON(
                AIRPORT_STATIONS_CACHE_URL
            );

        const rawAirports =
            extractAirportArray(
                raw
            );

        const normalized =
            rawAirports
                .map(
                    normalizeAirport
                )
                .filter(Boolean)
                .filter(
                    airport =>
                        airport.icao ||
                        airport.iata ||
                        airport.name
                );

        if (
            normalized.length === 0
        ) {

            throw new Error(
                "Airport cache contained no usable airport records"
            );
        }

        airportStationsCache =
            normalized;

        airportStationsCacheUpdated =
            now;

        console.log(
            `Airport cache loaded: ${normalized.length} records`
        );

        return normalized;

    } catch (
        error
    ) {

        console.error(
            "Could not load AviationWeather airport cache:",
            error.message
        );

        if (
            airportStationsCache
        ) {

            return airportStationsCache;
        }

        throw error;
    }
}

/*
|--------------------------------------------------------------------------
| AIRPORT SEARCH SCORE
|--------------------------------------------------------------------------
*/

function airportSearchScore(
    airport,
    query
) {

    const q =
        query
            .toLowerCase()
            .trim();

    const icao =
        String(
            airport.icao || ""
        ).toLowerCase();

    const iata =
        String(
            airport.iata || ""
        ).toLowerCase();

    const name =
        String(
            airport.name || ""
        ).toLowerCase();

    const city =
        String(
            airport.city || ""
        ).toLowerCase();

    const country =
        String(
            airport.country || ""
        ).toLowerCase();

    if (
        icao === q
    ) return 10000;

    if (
        iata === q
    ) return 9500;

    if (
        name === q
    ) return 9000;

    if (
        city === q
    ) return 8500;

    if (
        icao.startsWith(q)
    ) return 8000;

    if (
        iata.startsWith(q)
    ) return 7800;

    if (
        name.startsWith(q)
    ) return 7000;

    if (
        city.startsWith(q)
    ) return 6800;

    if (
        name.includes(q)
    ) return 6000;

    if (
        city.includes(q)
    ) return 5800;

    if (
        country.includes(q)
    ) return 4000;

    if (
        icao.includes(q)
    ) return 5000;

    if (
        iata.includes(q)
    ) return 4800;

    return 0;
}

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
    "/api/health",
    async (
        req,
        res
    ) => {

        let database =
            "Unavailable";

        try {

            await pool.query(
                "SELECT 1"
            );

            database =
                "Connected";

        } catch (
            error
        ) {

            console.error(
                "Database health check failed:",
                error.message
            );
        }

        res.json({

            status:
                "ok",

            service:
                "Flight-app backend",

            version:
                API_VERSION,

            database,

            timestamp:
                new Date().toISOString()
        });
    }
);

/*
|--------------------------------------------------------------------------
| DATABASE TEST
|--------------------------------------------------------------------------
*/

app.get(
    "/api/database/test",
    async (
        req,
        res
    ) => {

        try {

            const result =
                await pool.query(
                    "SELECT NOW() AS server_time"
                );

            res.json({

                available:
                    true,

                database:
                    "Connected",

                serverTime:
                    result.rows[0]
                        .server_time
            });

        } catch (
            error
        ) {

            console.error(
                "Database test failed:",
                error.message
            );

            res.status(503).json({

                available:
                    false,

                database:
                    "Unavailable"
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CHARTS - PUBLIC LIST
|--------------------------------------------------------------------------
*/

app.get(
    "/api/charts",
    async (
        req,
        res
    ) => {

        const icao =
            String(
                req.query.icao ||
                ""
            )
                .trim()
                .toUpperCase();

        const provider =
            String(
                req.query.provider ||
                ""
            )
                .trim()
                .toUpperCase();

        const category =
            String(
                req.query.category ||
                "ALL"
            )
                .trim()
                .toUpperCase();

        if (
            icao &&
            !validICAO(
                icao
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid ICAO code."
            });
        }

        if (
            provider &&
            !validChartProvider(
                provider
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid chart provider."
            });
        }

        if (
            category !== "ALL" &&
            !validChartType(
                category
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid chart category."
            });
        }

        try {

            const conditions =
                [];

            const values =
                [];

            let parameter =
                1;

            if (
                icao
            ) {

                conditions.push(
                    `airport_icao = $${parameter}`
                );

                values.push(
                    icao
                );

                parameter++;
            }

            if (
                provider
            ) {

                conditions.push(
                    `provider = $${parameter}`
                );

                values.push(
                    provider
                );

                parameter++;
            }

            if (
                category !== "ALL"
            ) {

                conditions.push(
                    `chart_type = $${parameter}`
                );

                values.push(
                    category
                );

                parameter++;
            }

            const where =
                conditions.length
                    ? `WHERE ${conditions.join(" AND ")}`
                    : "";

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        airport_icao,
                        airport_name,
                        chart_name,
                        chart_type,
                        provider,
                        file_name,
                        mime_type,
                        validity,
                        created_at
                    FROM charts
                    ${where}
                    ORDER BY
                        CASE chart_type
                            WHEN 'AIRPORT' THEN 1
                            WHEN 'APPROACH' THEN 2
                            WHEN 'SID' THEN 3
                            WHEN 'STAR' THEN 4
                            WHEN 'ENROUTE' THEN 5
                            ELSE 99
                        END,
                        chart_name ASC,
                        created_at DESC
                    `,
                    values
                );

            const baseUrl =
                getBaseUrl(
                    req
                );

            const charts =
                result.rows.map(
                    chart => ({

                        id:
                            chart.id,

                        airport_icao:
                            chart.airport_icao,

                        airport_name:
                            chart.airport_name,

                        chart_name:
                            chart.chart_name,

                        chart_type:
                            chart.chart_type,

                        provider:
                            chart.provider,

                        file_name:
                            chart.file_name,

                        mime_type:
                            chart.mime_type,

                        validity:
                            chart.validity,

                        created_at:
                            chart.created_at,

                        imageUrl:
                            `${baseUrl}/api/charts/${chart.id}/image`
                    })
                );

            return res.json({

                available:
                    true,

                count:
                    charts.length,

                charts
            });

        } catch (
            error
        ) {

            console.error(
                "Chart lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                charts:
                    [],

                error:
                    "Could not load charts."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CHARTS - ADMIN LIST
|--------------------------------------------------------------------------
*/

app.get(
    "/api/charts/admin/all",
    async (
        req,
        res
    ) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        airport_icao,
                        airport_name,
                        chart_name,
                        chart_type,
                        provider,
                        file_name,
                        mime_type,
                        validity,
                        created_at
                    FROM charts
                    ORDER BY
                        created_at DESC
                    `
                );

            const baseUrl =
                getBaseUrl(
                    req
                );

            const charts =
                result.rows.map(
                    chart => ({

                        ...chart,

                        imageUrl:
                            `${baseUrl}/api/charts/${chart.id}/image`
                    })
                );

            return res.json({

                available:
                    true,

                count:
                    charts.length,

                charts
            });

        } catch (
            error
        ) {

            console.error(
                "Admin chart lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                charts:
                    [],

                error:
                    "Could not load charts."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CHART IMAGE
|--------------------------------------------------------------------------
*/

app.get(
    "/api/charts/:id/image",
    async (
        req,
        res
    ) => {

        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid chart ID."
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        image_data,
                        mime_type,
                        file_name
                    FROM charts
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    available:
                        false,

                    error:
                        "Chart not found."
                });
            }

            const chart =
                result.rows[0];

            res.setHeader(
                "Content-Type",
                chart.mime_type ||
                    "image/png"
            );

            res.setHeader(
                "Content-Disposition",
                `inline; filename="${String(
                    chart.file_name ||
                    "chart"
                ).replace(
                    /"/g,
                    ""
                )}"`
            );

            res.setHeader(
                "Cache-Control",
                "public, max-age=86400"
            );

            return res.send(
                chart.image_data
            );

        } catch (
            error
        ) {

            console.error(
                "Chart image lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                error:
                    "Could not load chart image."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| UPLOAD CHART
|--------------------------------------------------------------------------
*/

app.post(
    "/api/charts",
    (
        req,
        res
    ) => {

        imageUpload.single(
            "image"
        )(
            req,
            res,
            async error => {

                if (
                    error
                ) {

                    return res.status(400).json({

                        available:
                            false,

                        error:
                            error.message
                    });
                }

                try {

                    const airportICAO =
                        String(
                            req.body.airport_icao ||
                            ""
                        )
                            .trim()
                            .toUpperCase();

                    const airportName =
                        cleanString(
                            req.body.airport_name,
                            200
                        );

                    const chartName =
                        cleanString(
                            req.body.chart_name,
                            200
                        );

                    const chartType =
                        String(
                            req.body.chart_type ||
                            "AIRPORT"
                        )
                            .trim()
                            .toUpperCase();

                    const provider =
                        String(
                            req.body.provider ||
                            "LIDO"
                        )
                            .trim()
                            .toUpperCase();

                    const validity =
                        cleanString(
                            req.body.validity,
                            200
                        );

                    if (
                        !validICAO(
                            airportICAO
                        )
                    ) {

                        return res.status(400).json({

                            available:
                                false,

                            error:
                                "A valid 4-letter ICAO code is required."
                        });
                    }

                    if (
                        !chartName
                    ) {

                        return res.status(400).json({

                            available:
                                false,

                            error:
                                "Chart name is required."
                        });
                    }

                    if (
                        !validChartType(
                            chartType
                        )
                    ) {

                        return res.status(400).json({

                            available:
                                false,

                            error:
                                "Invalid chart type."
                        });
                    }

                    if (
                        !validChartProvider(
                            provider
                        )
                    ) {

                        return res.status(400).json({

                            available:
                                false,

                            error:
                                "Invalid chart provider."
                        });
                    }

                    if (
                        !req.file
                    ) {

                        return res.status(400).json({

                            available:
                                false,

                            error:
                                "Chart image is required."
                        });
                    }

                    const result =
                        await pool.query(
                            `
                            INSERT INTO charts
                            (
                                airport_icao,
                                airport_name,
                                chart_name,
                                chart_type,
                                provider,
                                file_name,
                                mime_type,
                                image_data,
                                validity
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
                            RETURNING
                                id,
                                airport_icao,
                                airport_name,
                                chart_name,
                                chart_type,
                                provider,
                                file_name,
                                mime_type,
                                validity,
                                created_at
                            `,
                            [

                                airportICAO,

                                airportName ||
                                    null,

                                chartName,

                                chartType,

                                provider,

                                req.file.originalname,

                                req.file.mimetype,

                                req.file.buffer,

                                validity ||
                                    null
                            ]
                        );

                    const chart =
                        result.rows[0];

                    const baseUrl =
                        getBaseUrl(
                            req
                        );

                    return res.status(201).json({

                        available:
                            true,

                        message:
                            "Chart uploaded successfully.",

                        chart: {

                            ...chart,

                            imageUrl:
                                `${baseUrl}/api/charts/${chart.id}/image`
                        }
                    });

                } catch (
                    databaseError
                ) {

                    console.error(
                        "Could not upload chart:",
                        databaseError.message
                    );

                    return res.status(500).json({

                        available:
                            false,

                        error:
                            "Could not save chart."
                    });
                }
            }
        );
    }
);

/*
|--------------------------------------------------------------------------
| DELETE CHART
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/charts/:id",
    async (
        req,
        res
    ) => {

        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid chart ID."
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM charts
                    WHERE id = $1
                    RETURNING
                        id,
                        airport_icao,
                        chart_name
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    available:
                        false,

                    error:
                        "Chart not found."
                });
            }

            return res.json({

                available:
                    true,

                deleted:
                    true,

                chart:
                    result.rows[0]
            });

        } catch (
            error
        ) {

            console.error(
                "Could not delete chart:",
                error.message
            );

            return res.status(500).json({

                available:
                    false,

                error:
                    "Could not delete chart."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| SIMBRIEF - LATEST OFP
|--------------------------------------------------------------------------
*/

app.get(
    "/api/simbrief/latest",
    async (
        req,
        res
    ) => {

        const username =
            String(
                req.query.username ||
                ""
            ).trim();

        if (
            !username
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "SimBrief username is required."
            });
        }

        if (
            username.length > 80 ||
            !/^[a-zA-Z0-9_.-]+$/.test(
                username
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid SimBrief username."
            });
        }

        try {

            const url =
                "https://www.simbrief.com/api/xml.fetcher.php" +
                `?username=${encodeURIComponent(
                    username
                )}` +
                "&json=v2";

            console.log(
                `Fetching latest SimBrief OFP for: ${username}`
            );

            const data =
                await fetchJSON(
                    url
                );

            if (
                !data ||
                typeof data !==
                    "object"
            ) {

                return res.status(502).json({

                    available:
                        false,

                    error:
                        "SimBrief returned an empty or invalid response."
                });
            }

            return res.json({

                available:
                    true,

                source:
                    "SimBrief",

                username,

                ofp:
                    data
            });

        } catch (
            error
        ) {

            console.error(
                "SimBrief OFP fetch failed:",
                error.message
            );

            return res.status(502).json({

                available:
                    false,

                error:
                    "SimBrief did not return a valid latest OFP."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| WEATHER - METAR
|--------------------------------------------------------------------------
*/

app.get(
    "/api/weather/:icao",
    async (
        req,
        res
    ) => {

        const icao =
            String(
                req.params.icao ||
                ""
            )
                .trim()
                .toUpperCase();

        if (
            !validICAO(
                icao
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                icao,

                source:
                    "unavailable",

                message:
                    "Invalid ICAO code"
            });
        }

        try {

            const url =
                "https://aviationweather.gov/api/data/metar" +
                `?ids=${encodeURIComponent(
                    icao
                )}` +
                "&format=json";

            console.log(
                `Fetching live METAR for ${icao}...`
            );

            const data =
                await fetchJSON(
                    url
                );

            if (
                Array.isArray(
                    data
                ) &&
                data.length > 0
            ) {

                const metar =
                    data[0];

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
                        (
                            $1,
                            $2,
                            $3,
                            NOW()
                        )
                        `,
                        [

                            icao,

                            metar.rawOb ||
                                metar.raw_text ||
                                metar.rawObText ||
                                null,

                            JSON.stringify(
                                metar
                            )
                        ]
                    );

                } catch (
                    databaseError
                ) {

                    console.error(
                        `Could not cache METAR for ${icao}:`,
                        databaseError.message
                    );
                }

                return res.json({

                    available:
                        true,

                    source:
                        "live",

                    icao,

                    metar
                });
            }

        } catch (
            error
        ) {

            console.error(
                `Live METAR request failed for ${icao}:`,
                error.message
            );
        }

        try {

            const cached =
                await pool.query(
                    `
                    SELECT
                        icao,
                        metar,
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

            if (
                cached.rows.length > 0
            ) {

                const row =
                    cached.rows[0];

                const metar =
                    parseJsonValue(
                        row.raw_metar
                    );

                if (
                    metar
                ) {

                    return res.json({

                        available:
                            true,

                        source:
                            "cached",

                        icao,

                        cachedAt:
                            row.fetched_at,

                        metar
                    });
                }
            }

        } catch (
            databaseError
        ) {

            console.error(
                "Could not read cached METAR:",
                databaseError.message
            );
        }

        return res.json({

            available:
                false,

            source:
                "unavailable",

            icao,

            message:
                "No METAR available"
        });
    }
);

/*
|--------------------------------------------------------------------------
| WEATHER - TAF
|--------------------------------------------------------------------------
*/

app.get(
    "/api/weather/:icao/taf",
    async (
        req,
        res
    ) => {

        const icao =
            String(
                req.params.icao ||
                ""
            )
                .trim()
                .toUpperCase();

        if (
            !validICAO(
                icao
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                icao,

                message:
                    "Invalid ICAO code"
            });
        }

        try {

            const url =
                "https://aviationweather.gov/api/data/taf" +
                `?ids=${encodeURIComponent(
                    icao
                )}` +
                "&format=json";

            const data =
                await fetchJSON(
                    url
                );

            if (
                Array.isArray(
                    data
                ) &&
                data.length > 0
            ) {

                const taf =
                    data[0];

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
                        (
                            $1,
                            $2,
                            $3,
                            NOW()
                        )
                        `,
                        [

                            icao,

                            taf.rawTAF ||
                                taf.raw_taf ||
                                taf.raw_text ||
                                null,

                            JSON.stringify(
                                taf
                            )
                        ]
                    );

                } catch (
                    databaseError
                ) {

                    console.error(
                        "Could not cache TAF:",
                        databaseError.message
                    );
                }

                return res.json({

                    available:
                        true,

                    source:
                        "live",

                    icao,

                    taf
                });
            }

        } catch (
            error
        ) {

            console.error(
                `Live TAF request failed for ${icao}:`,
                error.message
            );
        }

        try {

            const cached =
                await pool.query(
                    `
                    SELECT
                        icao,
                        taf,
                        raw_taf,
                        fetched_at
                    FROM weather_cache
                    WHERE icao = $1
                    AND raw_taf IS NOT NULL
                    ORDER BY fetched_at DESC
                    LIMIT 1
                    `,
                    [icao]
                );

            if (
                cached.rows.length > 0
            ) {

                const row =
                    cached.rows[0];

                const taf =
                    parseJsonValue(
                        row.raw_taf
                    );

                if (
                    taf
                ) {

                    return res.json({

                        available:
                            true,

                        source:
                            "cached",

                        icao,

                        cachedAt:
                            row.fetched_at,

                        taf
                    });
                }
            }

        } catch (
            error
        ) {

            console.error(
                "Could not read cached TAF:",
                error.message
            );
        }

        return res.json({

            available:
                false,

            source:
                "unavailable",

            icao,

            message:
                "No TAF available"
        });
    }
);

/*
|--------------------------------------------------------------------------
| CACHED WEATHER
|--------------------------------------------------------------------------
*/

app.get(
    "/api/weather/:icao/cache",
    async (
        req,
        res
    ) => {

        const icao =
            String(
                req.params.icao ||
                ""
            )
                .trim()
                .toUpperCase();

        if (
            !validICAO(
                icao
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                message:
                    "Invalid ICAO code"
            });
        }

        try {

            const result =
                await pool.query(
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

            if (
                result.rows.length === 0
            ) {

                return res.json({

                    available:
                        false,

                    icao,

                    message:
                        "No cached data available"
                });
            }

            return res.json({

                available:
                    true,

                data:
                    result.rows[0]
            });

        } catch (
            error
        ) {

            console.error(
                "Cached weather lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                message:
                    "Unavailable"
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| AIRPORT SEARCH
|--------------------------------------------------------------------------
*/

app.get(
    "/api/airports/search",
    async (
        req,
        res
    ) => {

        const query =
            String(
                req.query.q ||
                req.query.query ||
                ""
            ).trim();

        if (
            !query
        ) {

            return res.json({

                available:
                    true,

                query:
                    "",

                count:
                    0,

                airports:
                    []
            });
        }

        if (
            query.length < 2
        ) {

            return res.json({

                available:
                    true,

                query,

                count:
                    0,

                airports:
                    []
            });
        }

        try {

            let directResults =
                [];

            const looksLikeICAO =
                /^[A-Za-z]{4}$/.test(
                    query
                );

            const looksLikeIATA =
                /^[A-Za-z]{3}$/.test(
                    query
                );

            if (
                looksLikeICAO ||
                looksLikeIATA
            ) {

                try {

                    const airportURL =
                        "https://aviationweather.gov/api/data/airport" +
                        `?ids=${encodeURIComponent(
                            query.toUpperCase()
                        )}` +
                        "&format=json";

                    const airportData =
                        await fetchJSON(
                            airportURL
                        );

                    if (
                        Array.isArray(
                            airportData
                        )
                    ) {

                        directResults =
                            airportData
                                .map(
                                    normalizeAirport
                                )
                                .filter(Boolean);

                    } else {

                        directResults =
                            extractAirportArray(
                                airportData
                            )
                                .map(
                                    normalizeAirport
                                )
                                .filter(Boolean);
                    }

                } catch (
                    directError
                ) {

                    console.warn(
                        "Direct airport API lookup failed:",
                        directError.message
                    );
                }
            }

            if (
                directResults.length > 0
            ) {

                const sorted =
                    directResults
                        .map(
                            airport => ({

                                ...airport,

                                score:
                                    airportSearchScore(
                                        airport,
                                        query
                                    )
                            })
                        )
                        .sort(
                            (a, b) =>
                                b.score -
                                a.score
                        )
                        .slice(
                            0,
                            10
                        )
                        .map(
                            airport => {

                                const {
                                    score,
                                    raw_data,
                                    ...cleanAirport
                                } = airport;

                                return cleanAirport;
                            }
                        );

                return res.json({

                    available:
                        true,

                    query,

                    count:
                        sorted.length,

                    airports:
                        sorted
                });
            }

            const stations =
                await getAirportStations();

            const matches =
                stations
                    .map(
                        airport => ({

                            airport,

                            score:
                                airportSearchScore(
                                    airport,
                                    query
                                )
                        })
                    )
                    .filter(
                        item =>
                            item.score > 0
                    )
                    .sort(
                        (a, b) => {

                            if (
                                b.score !==
                                a.score
                            ) {

                                return (
                                    b.score -
                                    a.score
                                );
                            }

                            return String(
                                a.airport.name ||
                                ""
                            ).localeCompare(
                                String(
                                    b.airport.name ||
                                    ""
                                )
                            );
                        }
                    )
                    .slice(
                        0,
                        10
                    )
                    .map(
                        item => {

                            const airport =
                                item.airport;

                            return {

                                icao:
                                    airport.icao,

                                iata:
                                    airport.iata,

                                name:
                                    airport.name,

                                city:
                                    airport.city,

                                country:
                                    airport.country,

                                latitude:
                                    airport.latitude,

                                longitude:
                                    airport.longitude,

                                elevation_ft:
                                    airport.elevation_ft
                            };
                        }
                    );

            return res.json({

                available:
                    true,

                query,

                count:
                    matches.length,

                airports:
                    matches
            });

        } catch (
            error
        ) {

            console.error(
                "Airport search failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                query,

                count:
                    0,

                airports:
                    [],

                error:
                    "Airport search is temporarily unavailable."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| AIRPORT INFORMATION
|--------------------------------------------------------------------------
*/

app.get(
    "/api/airports/:icao",
    async (
        req,
        res
    ) => {

        const icao =
            String(
                req.params.icao ||
                ""
            )
                .trim()
                .toUpperCase();

        if (
            !validICAO(
                icao
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                message:
                    "Invalid ICAO code"
            });
        }

        try {

            try {

                const airportResult =
                    await pool.query(
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

                if (
                    airportResult.rows.length > 0
                ) {

                    return res.json({

                        available:
                            true,

                        airport:
                            airportResult.rows[0]
                    });
                }

            } catch (
                cacheError
            ) {

                console.warn(
                    "Airport database cache unavailable:",
                    cacheError.message
                );
            }

            try {

                const url =
                    "https://aviationweather.gov/api/data/airport" +
                    `?ids=${encodeURIComponent(
                        icao
                    )}` +
                    "&format=json";

                const data =
                    await fetchJSON(
                        url
                    );

                if (
                    Array.isArray(
                        data
                    ) &&
                    data.length > 0
                ) {

                    const airport =
                        normalizeAirport(
                            data[0]
                        );

                    if (
                        airport
                    ) {

                        const normalized = {

                            icao:
                                airport.icao ||
                                icao,

                            name:
                                airport.name ||
                                "--",

                            iata:
                                airport.iata ||
                                null,

                            latitude:
                                airport.latitude,

                            longitude:
                                airport.longitude,

                            elevation_ft:
                                airport.elevation_ft,

                            country:
                                airport.country,

                            city:
                                airport.city,

                            raw_data:
                                airport.raw_data,

                            updated_at:
                                new Date()
                        };

                        try {

                            await pool.query(
                                `
                                INSERT INTO airport_cache
                                (
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
                                    $9,
                                    NOW()
                                )
                                ON CONFLICT (icao)
                                DO UPDATE SET
                                    name = EXCLUDED.name,
                                    iata = EXCLUDED.iata,
                                    latitude = EXCLUDED.latitude,
                                    longitude = EXCLUDED.longitude,
                                    elevation_ft = EXCLUDED.elevation_ft,
                                    country = EXCLUDED.country,
                                    city = EXCLUDED.city,
                                    raw_data = EXCLUDED.raw_data,
                                    updated_at = NOW()
                                `,
                                [

                                    normalized.icao,

                                    normalized.name,

                                    normalized.iata,

                                    normalized.latitude,

                                    normalized.longitude,

                                    normalized.elevation_ft,

                                    normalized.country,

                                    normalized.city,

                                    JSON.stringify(
                                        normalized.raw_data
                                    )
                                ]
                            );

                        } catch (
                            databaseError
                        ) {

                            console.warn(
                                "Could not cache airport:",
                                databaseError.message
                            );
                        }

                        return res.json({

                            available:
                                true,

                            airport:
                                normalized
                        });
                    }
                }

            } catch (
                airportApiError
            ) {

                console.warn(
                    `Airport API lookup for ${icao} failed:`,
                    airportApiError.message
                );
            }

            try {

                const stations =
                    await getAirportStations();

                const airport =
                    stations.find(
                        item =>
                            String(
                                item.icao ||
                                ""
                            )
                                .toUpperCase() ===
                            icao
                    );

                if (
                    airport
                ) {

                    return res.json({

                        available:
                            true,

                        airport: {

                            icao:
                                airport.icao,

                            name:
                                airport.name ||
                                "--",

                            iata:
                                airport.iata ||
                                null,

                            latitude:
                                airport.latitude,

                            longitude:
                                airport.longitude,

                            elevation_ft:
                                airport.elevation_ft,

                            country:
                                airport.country,

                            city:
                                airport.city,

                            raw_data:
                                airport.raw_data,

                            updated_at:
                                new Date()
                        }
                    });
                }

            } catch (
                stationError
            ) {

                console.warn(
                    "Airport station cache lookup failed:",
                    stationError.message
                );
            }

            return res.json({

                available:
                    false,

                icao,

                message:
                    "Unavailable"
            });

        } catch (
            error
        ) {

            console.error(
                "Airport information lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                icao,

                message:
                    "Unavailable"
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| SAVED PLANS
|--------------------------------------------------------------------------
*/

app.get(
    "/api/plans",
    async (
        req,
        res
    ) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM saved_plans
                    ORDER BY created_at DESC
                    `
                );

            return res.json({

                available:
                    true,

                plans:
                    result.rows
            });

        } catch (
            error
        ) {

            console.error(
                "Plans lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                plans:
                    []
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CREATE SAVED PLAN
|--------------------------------------------------------------------------
*/

app.post(
    "/api/plans",
    async (
        req,
        res
    ) => {

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

        if (
            !name ||
            String(
                name
            ).trim() === ""
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Plan name is required"
            });
        }

        if (
            departure_icao &&
            !validICAO(
                String(
                    departure_icao
                )
                    .toUpperCase()
                    .trim()
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid departure ICAO"
            });
        }

        if (
            arrival_icao &&
            !validICAO(
                String(
                    arrival_icao
                )
                    .toUpperCase()
                    .trim()
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid arrival ICAO"
            });
        }

        try {

            const result =
                await pool.query(
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

                        cleanString(
                            name,
                            200
                        ),

                        departure_icao
                            ? String(
                                departure_icao
                            )
                                .toUpperCase()
                                .trim()
                            : null,

                        arrival_icao
                            ? String(
                                arrival_icao
                            )
                                .toUpperCase()
                                .trim()
                            : null,

                        aircraft_icao
                            ? cleanString(
                                aircraft_icao,
                                50
                            )
                            : null,

                        cruise_altitude
                            ? Number(
                                cruise_altitude
                            )
                            : null,

                        route
                            ? cleanString(
                                route,
                                5000
                            )
                            : null,

                        distance_nm
                            ? Number(
                                distance_nm
                            )
                            : null,

                        estimated_minutes
                            ? Number(
                                estimated_minutes
                            )
                            : null,

                        simbrief_ofp_id
                            ? cleanString(
                                simbrief_ofp_id,
                                100
                            )
                            : null
                    ]
                );

            return res.status(201).json({

                available:
                    true,

                plan:
                    result.rows[0]
            });

        } catch (
            error
        ) {

            console.error(
                "Could not save plan:",
                error.message
            );

            return res.status(500).json({

                available:
                    false,

                error:
                    "Could not save plan"
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| DELETE SAVED PLAN
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/plans/:id",
    async (
        req,
        res
    ) => {

        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid plan ID"
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM saved_plans
                    WHERE id = $1
                    RETURNING id
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    available:
                        false,

                    error:
                        "Plan not found"
                });
            }

            return res.json({

                available:
                    true,

                deleted:
                    true,

                id
            });

        } catch (
            error
        ) {

            console.error(
                "Could not delete plan:",
                error.message
            );

            return res.status(500).json({

                available:
                    false,

                error:
                    "Could not delete plan"
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CHECKLISTS
|--------------------------------------------------------------------------
| AIRCRAFT TYPES
|--------------------------------------------------------------------------
|
| These are dynamic.
|
| You do NOT have to edit server.js to add a new aircraft.
|
|--------------------------------------------------------------------------
*/

/*
|--------------------------------------------------------------------------
| GET AIRCRAFT TYPES
|--------------------------------------------------------------------------
*/

app.get(
    "/api/aircraft",
    async (
        req,
        res
    ) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        manufacturer,
                        model,
                        code,
                        description,
                        image_url,
                        created_at
                    FROM aircraft_types
                    ORDER BY
                        manufacturer ASC NULLS LAST,
                        name ASC
                    `
                );

            return res.json({

                available:
                    true,

                count:
                    result.rows.length,

                aircraft:
                    result.rows
            });

        } catch (
            error
        ) {

            console.error(
                "Aircraft lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                aircraft:
                    [],

                error:
                    "Could not load aircraft types."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| GET SINGLE AIRCRAFT TYPE
|--------------------------------------------------------------------------
*/

app.get(
    "/api/aircraft/:id",
    async (
        req,
        res
    ) => {

        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid aircraft ID."
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        manufacturer,
                        model,
                        code,
                        description,
                        image_url,
                        created_at
                    FROM aircraft_types
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    available:
                        false,

                    error:
                        "Aircraft type not found."
                });
            }

            return res.json({

                available:
                    true,

                aircraft:
                    result.rows[0]
            });

        } catch (
            error
        ) {

            console.error(
                "Aircraft lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                error:
                    "Could not load aircraft type."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CREATE AIRCRAFT TYPE
|--------------------------------------------------------------------------
|
| Example:
|
| POST /api/aircraft
|
| {
|   "name": "Airbus A320",
|   "manufacturer": "Airbus",
|   "model": "A320",
|   "code": "A320",
|   "description": "Airbus A320 family"
| }
|
|--------------------------------------------------------------------------
*/

app.post(
    "/api/aircraft",
    async (
        req,
        res
    ) => {

        const name =
            cleanString(
                req.body.name,
                150
            );

        const manufacturer =
            cleanString(
                req.body.manufacturer,
                100
            );

        const model =
            cleanString(
                req.body.model,
                100
            );

        const code =
            cleanString(
                req.body.code,
                30
            )
                .toUpperCase();

        const description =
            cleanString(
                req.body.description,
                1000
            );

        const imageUrl =
            cleanString(
                req.body.image_url,
                500
            );

        if (
            !validAircraftName(
                name
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Aircraft name is required."
            });
        }

        if (
            !validAircraftCode(
                code
            )
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid aircraft code."
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    INSERT INTO aircraft_types
                    (
                        name,
                        manufacturer,
                        model,
                        code,
                        description,
                        image_url
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6
                    )
                    RETURNING
                        id,
                        name,
                        manufacturer,
                        model,
                        code,
                        description,
                        image_url,
                        created_at
                    `,
                    [

                        name,

                        manufacturer ||
                            null,

                        model ||
                            null,

                        code ||
                            null,

                        description ||
                            null,

                        imageUrl ||
                            null
                    ]
                );

            console.log(
                `Aircraft type added: ${name}`
            );

            return res.status(201).json({

                available:
                    true,

                message:
                    "Aircraft type created successfully.",

                aircraft:
                    result.rows[0]
            });

        } catch (
            error
        ) {

            console.error(
                "Could not create aircraft:",
                error.message
            );

            if (
                error.code === "23505"
            ) {

                return res.status(409).json({

                    available:
                        false,

                    error:
                        "This aircraft type already exists."
                });
            }

            return res.status(500).json({

                available:
                    false,

                error:
                    "Could not create aircraft type."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| DELETE AIRCRAFT TYPE
|--------------------------------------------------------------------------
|
| Checklists belonging to the aircraft are automatically deleted
| because the database uses ON DELETE CASCADE.
|
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/aircraft/:id",
    async (
        req,
        res
    ) => {

        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid aircraft ID."
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM aircraft_types
                    WHERE id = $1
                    RETURNING
                        id,
                        name
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    available:
                        false,

                    error:
                        "Aircraft type not found."
                });
            }

            console.log(
                `Aircraft type deleted: ${result.rows[0].name}`
            );

            return res.json({

                available:
                    true,

                deleted:
                    true,

                aircraft:
                    result.rows[0]
            });

        } catch (
            error
        ) {

            console.error(
                "Could not delete aircraft:",
                error.message
            );

            return res.status(500).json({

                available:
                    false,

                error:
                    "Could not delete aircraft type."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CHECKLIST - PUBLIC LIST
|--------------------------------------------------------------------------
|
| Examples:
|
| /api/checklists
| /api/checklists?aircraft_id=1
| /api/checklists?category=TAKEOFF
|
|--------------------------------------------------------------------------
*/

app.get(
    "/api/checklists",
    async (
        req,
        res
    ) => {

        const aircraftId =
            req.query.aircraft_id
                ? Number(
                    req.query.aircraft_id
                )
                : null;

        const category =
            req.query.category
                ? normalizeChecklistCategory(
                    req.query.category
                )
                : null;

        try {

            const conditions =
                [];

            const values =
                [];

            let parameter =
                1;

            if (
                aircraftId !== null
            ) {

                if (
                    !Number.isInteger(
                        aircraftId
                    ) ||
                    aircraftId <= 0
                ) {

                    return res.status(400).json({

                        available:
                            false,

                        error:
                            "Invalid aircraft ID."
                    });
                }

                conditions.push(
                    `c.aircraft_id = $${parameter}`
                );

                values.push(
                    aircraftId
                );

                parameter++;
            }

            if (
                category
            ) {

                conditions.push(
                    `c.category = $${parameter}`
                );

                values.push(
                    category
                );

                parameter++;
            }

            const where =
                conditions.length
                    ? `WHERE ${conditions.join(" AND ")}`
                    : "";

            const result =
                await pool.query(
                    `
                    SELECT
                        c.id,
                        c.aircraft_id,
                        a.name AS aircraft_name,
                        a.manufacturer,
                        a.model,
                        a.code AS aircraft_code,
                        c.name,
                        c.category,
                        c.description,
                        c.file_name,
                        c.mime_type,
                        c.notes,
                        c.created_at
                    FROM checklists c
                    INNER JOIN aircraft_types a
                        ON a.id = c.aircraft_id
                    ${where}
                    ORDER BY
                        a.manufacturer ASC NULLS LAST,
                        a.name ASC,
                        CASE c.category
                            WHEN 'PREFLIGHT' THEN 1
                            WHEN 'COCKPIT' THEN 2
                            WHEN 'BEFORE_START' THEN 3
                            WHEN 'START' THEN 4
                            WHEN 'TAXI' THEN 5
                            WHEN 'TAKEOFF' THEN 6
                            WHEN 'CLIMB' THEN 7
                            WHEN 'CRUISE' THEN 8
                            WHEN 'DESCENT' THEN 9
                            WHEN 'APPROACH' THEN 10
                            WHEN 'LANDING' THEN 11
                            WHEN 'SHUTDOWN' THEN 12
                            WHEN 'EMERGENCY' THEN 13
                            ELSE 99
                        END,
                        c.name ASC
                    `,
                    values
                );

            const baseUrl =
                getBaseUrl(
                    req
                );

            const checklists =
                result.rows.map(
                    checklist => ({

                        ...checklist,

                        imageUrl:
                            `${baseUrl}/api/checklists/${checklist.id}/image`
                    })
                );

            return res.json({

                available:
                    true,

                count:
                    checklists.length,

                checklists
            });

        } catch (
            error
        ) {

            console.error(
                "Checklist lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                checklists:
                    [],

                error:
                    "Could not load checklists."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CHECKLISTS FOR ONE AIRCRAFT
|--------------------------------------------------------------------------
*/

app.get(
    "/api/checklists/aircraft/:aircraftId",
    async (
        req,
        res
    ) => {

        const aircraftId =
            Number(
                req.params.aircraftId
            );

        if (
            !Number.isInteger(
                aircraftId
            ) ||
            aircraftId <= 0
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid aircraft ID."
            });
        }

        try {

            const aircraftResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        manufacturer,
                        model,
                        code,
                        description,
                        image_url,
                        created_at
                    FROM aircraft_types
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [aircraftId]
                );

            if (
                aircraftResult.rows.length === 0
            ) {

                return res.status(404).json({

                    available:
                        false,

                    error:
                        "Aircraft type not found."
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        aircraft_id,
                        name,
                        category,
                        description,
                        file_name,
                        mime_type,
                        notes,
                        created_at
                    FROM checklists
                    WHERE aircraft_id = $1
                    ORDER BY
                        CASE category
                            WHEN 'PREFLIGHT' THEN 1
                            WHEN 'COCKPIT' THEN 2
                            WHEN 'BEFORE_START' THEN 3
                            WHEN 'START' THEN 4
                            WHEN 'TAXI' THEN 5
                            WHEN 'TAKEOFF' THEN 6
                            WHEN 'CLIMB' THEN 7
                            WHEN 'CRUISE' THEN 8
                            WHEN 'DESCENT' THEN 9
                            WHEN 'APPROACH' THEN 10
                            WHEN 'LANDING' THEN 11
                            WHEN 'SHUTDOWN' THEN 12
                            WHEN 'EMERGENCY' THEN 13
                            ELSE 99
                        END,
                        name ASC
                    `,
                    [aircraftId]
                );

            const baseUrl =
                getBaseUrl(
                    req
                );

            const checklists =
                result.rows.map(
                    checklist => ({

                        ...checklist,

                        imageUrl:
                            `${baseUrl}/api/checklists/${checklist.id}/image`
                    })
                );

            return res.json({

                available:
                    true,

                aircraft:
                    aircraftResult.rows[0],

                count:
                    checklists.length,

                checklists
            });

        } catch (
            error
        ) {

            console.error(
                "Aircraft checklist lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                checklists:
                    [],

                error:
                    "Could not load aircraft checklists."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| SINGLE CHECKLIST
|--------------------------------------------------------------------------
*/

app.get(
    "/api/checklists/:id",
    async (
        req,
        res
    ) => {

        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid checklist ID."
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        c.id,
                        c.aircraft_id,
                        a.name AS aircraft_name,
                        a.manufacturer,
                        a.model,
                        a.code AS aircraft_code,
                        c.name,
                        c.category,
                        c.description,
                        c.file_name,
                        c.mime_type,
                        c.notes,
                        c.created_at
                    FROM checklists c
                    INNER JOIN aircraft_types a
                        ON a.id = c.aircraft_id
                    WHERE c.id = $1
                    LIMIT 1
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    available:
                        false,

                    error:
                        "Checklist not found."
                });
            }

            const baseUrl =
                getBaseUrl(
                    req
                );

            return res.json({

                available:
                    true,

                checklist: {

                    ...result.rows[0],

                    imageUrl:
                        `${baseUrl}/api/checklists/${id}/image`
                }
            });

        } catch (
            error
        ) {

            console.error(
                "Checklist lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                error:
                    "Could not load checklist."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CHECKLIST IMAGE
|--------------------------------------------------------------------------
*/

app.get(
    "/api/checklists/:id/image",
    async (
        req,
        res
    ) => {

        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid checklist ID."
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        image_data,
                        mime_type,
                        file_name
                    FROM checklists
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    available:
                        false,

                    error:
                        "Checklist not found."
                });
            }

            const checklist =
                result.rows[0];

            res.setHeader(
                "Content-Type",
                checklist.mime_type ||
                    "image/png"
            );

            res.setHeader(
                "Content-Disposition",
                `inline; filename="${String(
                    checklist.file_name ||
                    "checklist"
                ).replace(
                    /"/g,
                    ""
                )}"`
            );

            res.setHeader(
                "Cache-Control",
                "public, max-age=86400"
            );

            return res.send(
                checklist.image_data
            );

        } catch (
            error
        ) {

            console.error(
                "Checklist image lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                error:
                    "Could not load checklist image."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| UPLOAD CHECKLIST
|--------------------------------------------------------------------------
|
| multipart/form-data:
|
| aircraft_id
| name
| category
| description
| notes
| image
|
|--------------------------------------------------------------------------
*/

app.post(
    "/api/checklists",
    (
        req,
        res
    ) => {

        imageUpload.single(
            "image"
        )(
            req,
            res,
            async error => {

                if (
                    error
                ) {

                    console.error(
                        "Checklist upload middleware error:",
                        error.message
                    );

                    return res.status(400).json({

                        available:
                            false,

                        error:
                            error.message
                    });
                }

                try {

                    const aircraftId =
                        Number(
                            req.body.aircraft_id
                        );

                    const name =
                        cleanString(
                            req.body.name,
                            200
                        );

                    const category =
                        normalizeChecklistCategory(
                            req.body.category
                        );

                    const description =
                        cleanString(
                            req.body.description,
                            1000
                        );

                    const notes =
                        cleanString(
                            req.body.notes,
                            5000
                        );

                    if (
                        !Number.isInteger(
                            aircraftId
                        ) ||
                        aircraftId <= 0
                    ) {

                        return res.status(400).json({

                            available:
                                false,

                            error:
                                "A valid aircraft type is required."
                        });
                    }

                    if (
                        !name
                    ) {

                        return res.status(400).json({

                            available:
                                false,

                            error:
                                "Checklist name is required."
                        });
                    }

                    if (
                        !req.file
                    ) {

                        return res.status(400).json({

                            available:
                                false,

                            error:
                                "Checklist image is required."
                        });
                    }

                    const aircraftResult =
                        await pool.query(
                            `
                            SELECT
                                id,
                                name,
                                manufacturer,
                                model,
                                code
                            FROM aircraft_types
                            WHERE id = $1
                            LIMIT 1
                            `,
                            [aircraftId]
                        );

                    if (
                        aircraftResult.rows.length === 0
                    ) {

                        return res.status(404).json({

                            available:
                                false,

                            error:
                                "Aircraft type not found."
                        });
                    }

                    const result =
                        await pool.query(
                            `
                            INSERT INTO checklists
                            (
                                aircraft_id,
                                name,
                                category,
                                description,
                                file_name,
                                mime_type,
                                image_data,
                                notes
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
                                $8
                            )
                            RETURNING
                                id,
                                aircraft_id,
                                name,
                                category,
                                description,
                                file_name,
                                mime_type,
                                notes,
                                created_at
                            `,
                            [

                                aircraftId,

                                name,

                                category,

                                description ||
                                    null,

                                req.file.originalname,

                                req.file.mimetype,

                                req.file.buffer,

                                notes ||
                                    null
                            ]
                        );

                    const checklist =
                        result.rows[0];

                    const baseUrl =
                        getBaseUrl(
                            req
                        );

                    console.log(
                        `Checklist uploaded: ${aircraftResult.rows[0].name} - ${name}`
                    );

                    return res.status(201).json({

                        available:
                            true,

                        message:
                            "Checklist uploaded successfully.",

                        checklist: {

                            ...checklist,

                            aircraft:
                                aircraftResult.rows[0],

                            imageUrl:
                                `${baseUrl}/api/checklists/${checklist.id}/image`
                        }
                    });

                } catch (
                    databaseError
                ) {

                    console.error(
                        "Could not upload checklist:",
                        databaseError.message
                    );

                    return res.status(500).json({

                        available:
                            false,

                        error:
                            "Could not save checklist."
                    });
                }
            }
        );
    }
);

/*
|--------------------------------------------------------------------------
| DELETE CHECKLIST
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/checklists/:id",
    async (
        req,
        res
    ) => {

        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid checklist ID."
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    DELETE FROM checklists
                    WHERE id = $1
                    RETURNING
                        id,
                        aircraft_id,
                        name
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    available:
                        false,

                    error:
                        "Checklist not found."
                });
            }

            console.log(
                `Checklist deleted: ${result.rows[0].name}`
            );

            return res.json({

                available:
                    true,

                deleted:
                    true,

                checklist:
                    result.rows[0]
            });

        } catch (
            error
        ) {

            console.error(
                "Could not delete checklist:",
                error.message
            );

            return res.status(500).json({

                available:
                    false,

                error:
                    "Could not delete checklist."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| CHECKLIST ADMIN - EVERYTHING
|--------------------------------------------------------------------------
*/

app.get(
    "/api/checklists/admin/all",
    async (
        req,
        res
    ) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        c.id,
                        c.aircraft_id,
                        a.name AS aircraft_name,
                        a.manufacturer,
                        a.model,
                        a.code AS aircraft_code,
                        c.name,
                        c.category,
                        c.description,
                        c.file_name,
                        c.mime_type,
                        c.notes,
                        c.created_at
                    FROM checklists c
                    INNER JOIN aircraft_types a
                        ON a.id = c.aircraft_id
                    ORDER BY
                        c.created_at DESC
                    `
                );

            const baseUrl =
                getBaseUrl(
                    req
                );

            const checklists =
                result.rows.map(
                    checklist => ({

                        ...checklist,

                        imageUrl:
                            `${baseUrl}/api/checklists/${checklist.id}/image`
                    })
                );

            return res.json({

                available:
                    true,

                count:
                    checklists.length,

                checklists
            });

        } catch (
            error
        ) {

            console.error(
                "Checklist admin lookup failed:",
                error.message
            );

            return res.status(503).json({

                available:
                    false,

                checklists:
                    [],

                error:
                    "Could not load checklist administration data."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| DATABASE INITIALIZATION
|--------------------------------------------------------------------------
*/

async function initializeDatabase() {

    /*
    |--------------------------------------------------------------------------
    | CHARTS
    |--------------------------------------------------------------------------
    */

    await pool.query(
        `
        CREATE TABLE IF NOT EXISTS charts
        (
            id BIGSERIAL PRIMARY KEY,

            airport_icao VARCHAR(4) NOT NULL,

            airport_name TEXT,

            chart_name TEXT NOT NULL,

            chart_type VARCHAR(20) NOT NULL
                DEFAULT 'AIRPORT',

            provider VARCHAR(20) NOT NULL
                DEFAULT 'LIDO',

            file_name TEXT NOT NULL,

            mime_type VARCHAR(100) NOT NULL,

            image_data BYTEA NOT NULL,

            validity TEXT,

            created_at TIMESTAMPTZ NOT NULL
                DEFAULT NOW()
        )
        `
    );

    await pool.query(
        `
        CREATE INDEX IF NOT EXISTS
        charts_airport_provider_type_idx
        ON charts
        (
            airport_icao,
            provider,
            chart_type
        )
        `
    );

    await pool.query(
        `
        CREATE INDEX IF NOT EXISTS
        charts_created_at_idx
        ON charts
        (
            created_at DESC
        )
        `
    );

    /*
    |--------------------------------------------------------------------------
    | WEATHER CACHE
    |--------------------------------------------------------------------------
    */

    await pool.query(
        `
        CREATE TABLE IF NOT EXISTS weather_cache
        (
            id BIGSERIAL PRIMARY KEY,

            icao VARCHAR(4) NOT NULL,

            metar TEXT,

            taf TEXT,

            raw_metar JSONB,

            raw_taf JSONB,

            fetched_at TIMESTAMPTZ NOT NULL
                DEFAULT NOW()
        )
        `
    );

    await pool.query(
        `
        CREATE INDEX IF NOT EXISTS
        weather_cache_icao_fetched_at_idx
        ON weather_cache
        (
            icao,
            fetched_at DESC
        )
        `
    );

    /*
    |--------------------------------------------------------------------------
    | AIRPORT CACHE
    |--------------------------------------------------------------------------
    */

    await pool.query(
        `
        CREATE TABLE IF NOT EXISTS airport_cache
        (
            icao VARCHAR(4) PRIMARY KEY,

            name TEXT,

            iata VARCHAR(3),

            latitude DOUBLE PRECISION,

            longitude DOUBLE PRECISION,

            elevation_ft DOUBLE PRECISION,

            country TEXT,

            city TEXT,

            raw_data JSONB,

            updated_at TIMESTAMPTZ NOT NULL
                DEFAULT NOW()
        )
        `
    );

    /*
    |--------------------------------------------------------------------------
    | SAVED PLANS
    |--------------------------------------------------------------------------
    */

    await pool.query(
        `
        CREATE TABLE IF NOT EXISTS saved_plans
        (
            id BIGSERIAL PRIMARY KEY,

            name TEXT NOT NULL,

            departure_icao VARCHAR(4),

            arrival_icao VARCHAR(4),

            aircraft_icao TEXT,

            cruise_altitude INTEGER,

            route TEXT,

            distance_nm DOUBLE PRECISION,

            estimated_minutes INTEGER,

            simbrief_ofp_id TEXT,

            created_at TIMESTAMPTZ NOT NULL
                DEFAULT NOW()
        )
        `
    );

    await pool.query(
        `
        CREATE INDEX IF NOT EXISTS
        saved_plans_created_at_idx
        ON saved_plans
        (
            created_at DESC
        )
        `
    );

    /*
    |--------------------------------------------------------------------------
    | AIRCRAFT TYPES
    |--------------------------------------------------------------------------
    */

    await pool.query(
        `
        CREATE TABLE IF NOT EXISTS aircraft_types
        (
            id BIGSERIAL PRIMARY KEY,

            name TEXT NOT NULL,

            manufacturer TEXT,

            model TEXT,

            code VARCHAR(30),

            description TEXT,

            image_url TEXT,

            created_at TIMESTAMPTZ NOT NULL
                DEFAULT NOW()
        )
        `
    );

    await pool.query(
        `
        CREATE INDEX IF NOT EXISTS
        aircraft_types_name_idx
        ON aircraft_types
        (
            name
        )
        `
    );

    /*
    |--------------------------------------------------------------------------
    | AIRCRAFT CODE UNIQUE INDEX
    |--------------------------------------------------------------------------
    |
    | NULL values are allowed multiple times.
    |
    |--------------------------------------------------------------------------
    */

    await pool.query(
        `
        CREATE UNIQUE INDEX IF NOT EXISTS
        aircraft_types_code_unique_idx
        ON aircraft_types
        (
            code
        )
        WHERE code IS NOT NULL
        `
    );

    /*
    |--------------------------------------------------------------------------
    | CHECKLISTS
    |--------------------------------------------------------------------------
    */

    await pool.query(
        `
        CREATE TABLE IF NOT EXISTS checklists
        (
            id BIGSERIAL PRIMARY KEY,

            aircraft_id BIGINT NOT NULL
                REFERENCES aircraft_types(id)
                ON DELETE CASCADE,

            name TEXT NOT NULL,

            category VARCHAR(30) NOT NULL
                DEFAULT 'OTHER',

            description TEXT,

            file_name TEXT NOT NULL,

            mime_type VARCHAR(100) NOT NULL,

            image_data BYTEA NOT NULL,

            notes TEXT,

            created_at TIMESTAMPTZ NOT NULL
                DEFAULT NOW()
        )
        `
    );

    await pool.query(
        `
        CREATE INDEX IF NOT EXISTS
        checklists_aircraft_idx
        ON checklists
        (
            aircraft_id
        )
        `
    );

    await pool.query(
        `
        CREATE INDEX IF NOT EXISTS
        checklists_aircraft_category_idx
        ON checklists
        (
            aircraft_id,
            category
        )
        `
    );

    await pool.query(
        `
        CREATE INDEX IF NOT EXISTS
        checklists_created_at_idx
        ON checklists
        (
            created_at DESC
        )
        `
    );

    console.log(
        "Database tables and indexes are ready."
    );
}

/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get(
    "/",
    async (
        req,
        res
    ) => {

        let database =
            "Unavailable";

        try {

            await pool.query(
                "SELECT 1"
            );

            database =
                "Connected";

        } catch (
            error
        ) {

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

            version:
                API_VERSION,

            database,

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

                airportSearch:
                    "/api/airports/search?q=Amsterdam",

                airports:
                    "/api/airports/:icao",

                plans:
                    "/api/plans",

                charts:
                    "/api/charts",

                chartImage:
                    "/api/charts/:id/image",

                chartAdminAll:
                    "/api/charts/admin/all",

                aircraft:
                    "/api/aircraft",

                aircraftSingle:
                    "/api/aircraft/:id",

                checklists:
                    "/api/checklists",

                checklistsByAircraft:
                    "/api/checklists/aircraft/:aircraftId",

                checklistSingle:
                    "/api/checklists/:id",

                checklistImage:
                    "/api/checklists/:id/image",

                checklistAdminAll:
                    "/api/checklists/admin/all"
            }
        });
    }
);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use(
    (
        req,
        res
    ) => {

        res.status(404).json({

            available:
                false,

            error:
                "Endpoint not found"
        });
    }
);

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(
            "Unhandled server error:",
            error
        );

        if (
            res.headersSent
        ) {

            return next(
                error
            );
        }

        res.status(500).json({

            available:
                false,

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

    console.log(
        "=================================================="
    );

    console.log(
        `Flight-app backend v${API_VERSION} starting...`
    );

    console.log(
        "=================================================="
    );

    console.log(
        "PORT:",
        PORT
    );

    console.log(
        "DATABASE_URL exists:",
        Boolean(
            process.env.DATABASE_URL
        )
    );

    try {

        /*
        |--------------------------------------------------------------------------
        | DATABASE CONNECTION TEST
        |--------------------------------------------------------------------------
        */

        console.log(
            "Testing Neon PostgreSQL connection..."
        );

        const databaseTest =
            await pool.query(
                "SELECT NOW() AS current_time"
            );

        console.log(
            "Neon PostgreSQL connection successful."
        );

        console.log(
            "Database time:",
            databaseTest.rows[0].current_time
        );


        /*
        |--------------------------------------------------------------------------
        | DATABASE INITIALIZATION
        |--------------------------------------------------------------------------
        */

        console.log(
            "Initializing database tables..."
        );

        await initializeDatabase();

        console.log(
            "Database initialization successful."
        );


        /*
        |--------------------------------------------------------------------------
        | START EXPRESS
        |--------------------------------------------------------------------------
        */

        const server =
            app.listen(
                PORT,
                "0.0.0.0",
                () => {

                    console.log(
                        "=================================================="
                    );

                    console.log(
                        `Flight-app backend v${API_VERSION} is ONLINE`
                    );

                    console.log(
                        `Listening on port ${PORT}`
                    );

                    console.log(
                        "Checklist system enabled."
                    );

                    console.log(
                        "Aircraft type management enabled."
                    );

                    console.log(
                        "Charts system enabled."
                    );

                    console.log(
                        "Weather system enabled."
                    );

                    console.log(
                        "SimBrief system enabled."
                    );

                    console.log(
                        "=================================================="
                    );
                }
            );


        /*
        |--------------------------------------------------------------------------
        | SERVER ERROR
        |--------------------------------------------------------------------------
        */

        server.on(
            "error",
            error => {

                console.error(
                    "Express server error:",
                    error
                );

            }
        );


    } catch (error) {

        console.error(
            "=================================================="
        );

        console.error(
            "COULD NOT INITIALIZE FLIGHT-APP BACKEND"
        );

        console.error(
            "=================================================="
        );

        console.error(
            "Full error:",
            error
        );

        console.error(
            "Error message:",
            error?.message
        );

        console.error(
            "Error code:",
            error?.code
        );

        console.error(
            "Error name:",
            error?.name
        );

        console.error(
            "Error stack:",
            error?.stack
        );

        console.error(
            "DATABASE_URL exists:",
            Boolean(
                process.env.DATABASE_URL
            )
        );

        console.error(
            "PORT:",
            PORT
        );

        console.error(
            "=================================================="
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

async function shutdown(
    signal
) {

    console.log(
        `${signal} received.`
    );

    try {

        await pool.end();

        console.log(
            "Database connection pool closed."
        );

    } catch (
        error
    ) {

        console.error(
            "Error while closing database pool:",
            error.message
        );
    }

    process.exit(0);
}

process.on(
    "SIGTERM",
    () => shutdown(
        "SIGTERM"
    )
);

process.on(
    "SIGINT",
    () => shutdown(
        "SIGINT"
    )
);
