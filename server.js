const express = require("express");
const cors = require("cors");
const https = require("https");
const zlib = require("zlib");
const multer = require("multer");
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
| CHART UPLOAD CONFIGURATION
|--------------------------------------------------------------------------
*/

const chartUpload = multer({

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

function validICAO(icao) {

    return /^[A-Z]{4}$/.test(
        String(icao || "")
            .trim()
            .toUpperCase()
    );

}

/*
|--------------------------------------------------------------------------
| CHART VALIDATION HELPERS
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
        String(type || "")
            .trim()
            .toUpperCase()
    );

}


function validChartProvider(
    provider
) {

    return VALID_CHART_PROVIDERS.includes(
        String(provider || "")
            .trim()
            .toUpperCase()
    );

}


/*
|--------------------------------------------------------------------------
| HTTPS JSON FETCH
|--------------------------------------------------------------------------
*/

function fetchJSON(url) {

    return new Promise(
        (resolve, reject) => {

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

                        let data = "";

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

                                /*
                                |--------------------------------------------------------------------------
                                | HTTP 204 = NO CONTENT
                                |--------------------------------------------------------------------------
                                */

                                if (
                                    response.statusCode === 204 ||
                                    !data.trim()
                                ) {

                                    resolve([]);

                                    return;

                                }

                                try {

                                    resolve(
                                        JSON.parse(
                                            data
                                        )
                                    );

                                } catch (error) {

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

function fetchGzipJSON(url) {

    return new Promise(
        (resolve, reject) => {

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

                            reject(
                                new Error(
                                    `External cache returned HTTP ${response.statusCode}`
                                )
                            );

                            response.resume();

                            return;

                        }

                        const gunzip =
                            zlib.createGunzip();

                        let output = "";

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

                                } catch (error) {

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
    24 * 60 * 60 * 1000;


/*
|--------------------------------------------------------------------------
| AIRPORT DATA NORMALIZER
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
        ).trim();

    const city =
        String(
            raw.city ??
            raw.municipality ??
            raw.municipalityName ??
            raw.town ??
            raw.locality ??
            raw.location_city ??
            ""
        ).trim();

    const country =
        String(
            raw.country ??
            raw.countryName ??
            raw.country_name ??
            raw.countryCode ??
            raw.country_code ??
            ""
        ).trim();

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
        raw.longitudeDeg ??
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
| EXTRACT AIRPORT ARRAY FROM CACHE
|--------------------------------------------------------------------------
*/

function extractAirportArray(
    data
) {

    if (
        Array.isArray(data)
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
            Array.isArray(value)
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

    } catch (error) {

        console.error(
            "Could not load AviationWeather airport cache:",
            error.message
        );

        if (
            airportStationsCache
        ) {

            console.log(
                "Using previously loaded airport cache."
            );

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
    ) {

        return 10000;

    }

    if (
        iata === q
    ) {

        return 9500;

    }

    if (
        name === q
    ) {

        return 9000;

    }

    if (
        city === q
    ) {

        return 8500;

    }

    if (
        icao.startsWith(q)
    ) {

        return 8000;

    }

    if (
        iata.startsWith(q)
    ) {

        return 7800;

    }

    if (
        name.startsWith(q)
    ) {

        return 7000;

    }

    if (
        city.startsWith(q)
    ) {

        return 6800;

    }

    if (
        name.includes(q)
    ) {

        return 6000;

    }

    if (
        city.includes(q)
    ) {

        return 5800;

    }

    if (
        country.includes(q)
    ) {

        return 4000;

    }

    if (
        icao.includes(q)
    ) {

        return 5000;

    }

    if (
        iata.includes(q)
    ) {

        return 4800;

    }

    return 0;

}


/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
    "/api/health",
    async (req, res) => {

        let database =
            "Unavailable";

        try {

            await pool.query(
                "SELECT 1"
            );

            database =
                "Connected";

        } catch (error) {

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
    async (req, res) => {

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
                    result.rows[0].server_time

            });

        } catch (error) {

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
|
| Examples:
|
| /api/charts
| /api/charts?icao=EHAM
| /api/charts?icao=EHAM&provider=LIDO
| /api/charts?icao=EHAM&provider=LIDO&category=APPROACH
|
|--------------------------------------------------------------------------
*/

app.get(
    "/api/charts",
    async (req, res) => {

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
            !validICAO(icao)
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

            const conditions = [];

            const values = [];

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
                            `/api/charts/${chart.id}/image`

                    })
                );

            return res.json({

                available:
                    true,

                count:
                    charts.length,

                charts

            });

        } catch (error) {

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
|
| Public because chart admin authentication has been removed.
|
|--------------------------------------------------------------------------
*/

app.get(
    "/api/charts/admin/all",
    async (req, res) => {

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

            const charts =
                result.rows.map(
                    chart => ({

                        ...chart,

                        imageUrl:
                            `/api/charts/${chart.id}/image`

                    })
                );

            return res.json({

                available:
                    true,

                count:
                    charts.length,

                charts

            });

        } catch (error) {

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
    async (req, res) => {

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

        } catch (error) {

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
|
| Public because chart admin authentication has been removed.
|
|--------------------------------------------------------------------------
*/

app.post(
    "/api/charts",
    (req, res) => {

        chartUpload.single(
            "image"
        )(
            req,
            res,
            async error => {

                if (
                    error
                ) {

                    console.error(
                        "Chart upload middleware error:",
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

                    const airportICAO =
                        String(
                            req.body.airport_icao ||
                            ""
                        )
                            .trim()
                            .toUpperCase();

                    const airportName =
                        String(
                            req.body.airport_name ||
                            ""
                        ).trim();

                    const chartName =
                        String(
                            req.body.chart_name ||
                            ""
                        ).trim();

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
                        String(
                            req.body.validity ||
                            ""
                        ).trim();


                    /*
                    |--------------------------------------------------------------------------
                    | VALIDATION
                    |--------------------------------------------------------------------------
                    */

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


                    /*
                    |--------------------------------------------------------------------------
                    | DATABASE INSERT
                    |--------------------------------------------------------------------------
                    */

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

                    console.log(
                        `Chart uploaded: ${airportICAO} - ${chartName}`
                    );

                    return res.status(201).json({

                        available:
                            true,

                        message:
                            "Chart uploaded successfully.",

                        chart: {

                            ...chart,

                            imageUrl:
                                `/api/charts/${chart.id}/image`

                        }

                    });

                } catch (databaseError) {

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
|
| Public because chart admin authentication has been removed.
|
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/charts/:id",
    async (req, res) => {

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

            console.log(
                `Chart deleted: ${result.rows[0].airport_icao} - ${result.rows[0].chart_name}`
            );

            return res.json({

                available:
                    true,

                deleted:
                    true,

                chart:
                    result.rows[0]

            });

        } catch (error) {

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
    async (req, res) => {

        const username =
            String(
                req.query.username || ""
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
            username.length > 80
        ) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid SimBrief username."

            });

        }

        if (
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
                typeof data !== "object"
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

        } catch (error) {

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
    async (req, res) => {

        const icao =
            req.params.icao
                .toUpperCase()
                .trim();

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
                "https://aviationweather.gov/api/data/metar" +
                `?ids=${encodeURIComponent(
                    icao
                )}` +
                "&format=json";

            const data =
                await fetchJSON(
                    url
                );

            if (
                !Array.isArray(data) ||
                data.length === 0
            ) {

                return res.json({

                    available:
                        false,

                    icao,

                    message:
                        "Unavailable"

                });

            }

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
                    ($1, $2, $3, NOW())
                    `,
                    [

                        icao,

                        metar.rawOb ||
                            metar.raw_text ||
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
                    "Could not cache METAR:",
                    databaseError.message
                );

            }

            res.json({

                available:
                    true,

                icao,

                metar

            });

        } catch (error) {

            console.error(
                "METAR request failed:",
                error.message
            );

            res.status(502).json({

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
| WEATHER - TAF
|--------------------------------------------------------------------------
*/

app.get(
    "/api/weather/:icao/taf",
    async (req, res) => {

        const icao =
            req.params.icao
                .toUpperCase()
                .trim();

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
                !Array.isArray(data) ||
                data.length === 0
            ) {

                return res.json({

                    available:
                        false,

                    icao,

                    message:
                        "Unavailable"

                });

            }

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
                    ($1, $2, $3, NOW())
                    `,
                    [

                        icao,

                        taf.rawTAF ||
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

            res.json({

                available:
                    true,

                icao,

                taf

            });

        } catch (error) {

            console.error(
                "TAF request failed:",
                error.message
            );

            res.status(502).json({

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
| CACHED WEATHER
|--------------------------------------------------------------------------
*/

app.get(
    "/api/weather/:icao/cache",
    async (req, res) => {

        const icao =
            req.params.icao
                .toUpperCase()
                .trim();

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

            res.json({

                available:
                    true,

                data:
                    result.rows[0]

            });

        } catch (error) {

            console.error(
                "Cached weather lookup failed:",
                error.message
            );

            res.status(503).json({

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
    async (req, res) => {

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

            console.log(
                `Airport search: "${query}"`
            );

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

                    } else if (
                        airportData &&
                        typeof airportData ===
                            "object"
                    ) {

                        const extracted =
                            extractAirportArray(
                                airportData
                            );

                        directResults =
                            extracted
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

                                return {
                                    ...cleanAirport
                                };

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

                            const aName =
                                String(
                                    a.airport.name ||
                                    ""
                                );

                            const bName =
                                String(
                                    b.airport.name ||
                                    ""
                                );

                            return aName.localeCompare(
                                bName
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

            console.log(
                `Airport search "${query}" returned ${matches.length} result(s).`
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

        } catch (error) {

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
    async (req, res) => {

        const icao =
            req.params.icao
                .toUpperCase()
                .trim();

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
                    Array.isArray(data) &&
                    data.length > 0
                ) {

                    const airport =
                        normalizeAirport(
                            data[0]
                        );

                    if (
                        airport
                    ) {

                        return res.json({

                            available:
                                true,

                            airport: {

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

                            }

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
                                item.icao || ""
                            ).toUpperCase() ===
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

            const weatherResult =
                await pool.query(
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

            if (
                weatherResult.rows.length === 0
            ) {

                return res.json({

                    available:
                        false,

                    icao,

                    message:
                        "Unavailable"

                });

            }

            let metarData;

            try {

                metarData =
                    typeof weatherResult.rows[0].raw_metar ===
                    "string"

                        ? JSON.parse(
                            weatherResult.rows[0].raw_metar
                        )

                        : weatherResult.rows[0].raw_metar;

            } catch (
                parseError
            ) {

                console.error(
                    "Could not parse cached METAR:",
                    parseError.message
                );

                return res.json({

                    available:
                        false,

                    icao,

                    message:
                        "Unavailable"

                });

            }

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
                        ? Number(
                            metarData.lat
                        )
                        : null,

                longitude:
                    metarData.lon != null
                        ? Number(
                            metarData.lon
                        )
                        : null,

                elevation_ft:
                    metarData.elev != null
                        ? Number(
                            metarData.elev
                        )
                        : null,

                country:
                    null,

                city:
                    null,

                raw_data:
                    metarData,

                updated_at:
                    weatherResult.rows[0]
                        .fetched_at

            };

            return res.json({

                available:
                    true,

                airport

            });

        } catch (error) {

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
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM saved_plans
                    ORDER BY created_at DESC
                    `
                );

            res.json({

                available:
                    true,

                plans:
                    result.rows

            });

        } catch (error) {

            console.error(
                "Plans lookup failed:",
                error.message
            );

            res.status(503).json({

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
    async (req, res) => {

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
            String(name).trim() === ""
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

                        String(
                            name
                        ).trim(),

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
                            ? String(
                                aircraft_icao
                            )
                                .toUpperCase()
                                .trim()
                            : null,

                        cruise_altitude
                            ? Number(
                                cruise_altitude
                            )
                            : null,

                        route
                            ? String(
                                route
                            ).trim()
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
                            ? String(
                                simbrief_ofp_id
                            ).trim()
                            : null

                    ]
                );

            return res.status(201).json({

                available:
                    true,

                plan:
                    result.rows[0]

            });

        } catch (error) {

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
    async (req, res) => {

        const id =
            Number(
                req.params.id
            );

        if (
            !Number.isInteger(id)
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

        } catch (error) {

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
| DATABASE INITIALIZATION
|--------------------------------------------------------------------------
|
| Creates the charts table automatically.
|
| Existing tables are NOT modified.
|
|--------------------------------------------------------------------------
*/

async function initializeDatabase() {

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

    console.log(
        "Charts database table is ready."
    );

}


/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get(
    "/",
    async (req, res) => {

        let database =
            "Unavailable";

        try {

            await pool.query(
                "SELECT 1"
            );

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
                "1.3.0",

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
                    "/api/charts/admin/all"

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
    (req, res) => {

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

    try {

        await pool.query(
            "SELECT 1"
        );

        console.log(
            "Successfully connected to Neon PostgreSQL."
        );

        /*
        |--------------------------------------------------------------------------
        | CREATE CHART TABLE / INDEXES
        |--------------------------------------------------------------------------
        */

        await initializeDatabase();

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
            "Could not initialize Flight-app backend:",
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
