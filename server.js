/*
|--------------------------------------------------------------------------
| MSFS 2024 CHARTS BRIDGE
|--------------------------------------------------------------------------
|
| Echo Flight App
|
| This server acts as a bridge between:
|
|   1. charts.html
|   2. Microsoft Flight Simulator 2024
|   3. The MSFS 2024 Charts API
|
| Browser
|    ↓ HTTP
| Bridge
|    ↓ WebSocket
| MSFS 2024 Add-on
|    ↓
| Charts API
|
|--------------------------------------------------------------------------
*/

const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8765);

const BRIDGE_VERSION = "1.0.0";

const REQUEST_TIMEOUT = 30000;

/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

const app = express();

app.use(
    cors({
        origin: true,
        credentials: false
    })
);

app.use(
    express.json({
        limit: "10mb"
    })
);

/*
|--------------------------------------------------------------------------
| STATE
|--------------------------------------------------------------------------
*/

let msfsClient = null;

let requestCounter = 0;

const pendingRequests = new Map();

let msfsInfo = {
    connected: false,
    connectedAt: null,
    lastMessageAt: null,
    simulator: "Microsoft Flight Simulator 2024",
    chartsApi: false
};

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function nowISO() {
    return new Date().toISOString();
}

function normalizeProvider(provider) {
    const value = String(provider || "")
        .trim()
        .toUpperCase();

    if (value === "LIDO") {
        return "LIDO";
    }

    if (value === "FAA") {
        return "FAA";
    }

    return null;
}

function normalizeICAO(icao) {
    return String(icao || "")
        .trim()
        .toUpperCase();
}

function isValidICAO(icao) {
    return /^[A-Z]{4}$/.test(icao);
}

function sendToMSFS(message) {
    if (!msfsClient) {
        throw new Error(
            "Microsoft Flight Simulator 2024 is not connected."
        );
    }

    if (msfsClient.readyState !== WebSocket.OPEN) {
        throw new Error(
            "MSFS WebSocket is not open."
        );
    }

    msfsClient.send(
        JSON.stringify(message)
    );
}

/*
|--------------------------------------------------------------------------
| REQUEST SYSTEM
|--------------------------------------------------------------------------
*/

function createMSFSRequest(type, payload = {}) {
    return new Promise((resolve, reject) => {

        if (!msfsClient) {
            reject(
                new Error(
                    "Microsoft Flight Simulator 2024 is not connected."
                )
            );

            return;
        }

        if (msfsClient.readyState !== WebSocket.OPEN) {
            reject(
                new Error(
                    "MSFS WebSocket connection is not open."
                )
            );

            return;
        }

        const id = ++requestCounter;

        const timeout = setTimeout(() => {

            pendingRequests.delete(id);

            reject(
                new Error(
                    `MSFS request timed out after ${REQUEST_TIMEOUT / 1000} seconds.`
                )
            );

        }, REQUEST_TIMEOUT);

        pendingRequests.set(id, {
            resolve,
            reject,
            timeout,
            type,
            createdAt: Date.now()
        });

        try {

            msfsClient.send(
                JSON.stringify({
                    type,
                    id,
                    ...payload
                })
            );

        } catch (error) {

            clearTimeout(timeout);

            pendingRequests.delete(id);

            reject(error);
        }
    });
}

/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {

    res.json({
        service: "MSFS 2024 Charts API Bridge",
        status: "online",
        version: BRIDGE_VERSION,

        host: HOST,
        port: PORT,

        msfsConnected:
            !!msfsClient &&
            msfsClient.readyState === WebSocket.OPEN,

        chartsApi:
            msfsInfo.chartsApi,

        providerSupport: [
            "LIDO",
            "FAA"
        ],

        endpoints: {
            status: "/api/status",
            charts: "/api/charts/:provider/:icao",
            pages: "/api/charts/pages/:guid",
            image: "/api/charts/image?url=...",
            request: "/api/charts/request"
        }
    });
});

/*
|--------------------------------------------------------------------------
| STATUS
|--------------------------------------------------------------------------
*/

app.get("/api/status", (req, res) => {

    const connected =
        !!msfsClient &&
        msfsClient.readyState === WebSocket.OPEN;

    res.json({

        available: true,

        bridge: {
            name: "MSFS 2024 Charts API Bridge",
            version: BRIDGE_VERSION,
            online: true
        },

        msfs: {
            connected,
            connectedAt: msfsInfo.connectedAt,
            lastMessageAt: msfsInfo.lastMessageAt,
            simulator: msfsInfo.simulator,
            chartsApi: msfsInfo.chartsApi
        },

        providers: [
            {
                id: "LIDO",
                name: "LIDO",
                available: connected
            },
            {
                id: "FAA",
                name: "FAA",
                available: connected
            }
        ]
    });
});

/*
|--------------------------------------------------------------------------
| PING MSFS
|--------------------------------------------------------------------------
*/

app.get("/api/msfs/ping", async (req, res) => {

    try {

        const result =
            await createMSFSRequest(
                "PING_MSFS"
            );

        res.json({
            available: true,
            result
        });

    } catch (error) {

        res.status(502).json({
            available: false,
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| GET CHART INDEX
|--------------------------------------------------------------------------
|
| Example:
|
| GET /api/charts/LIDO/EHAM
|
*/

app.get(
    "/api/charts/:provider/:icao",
    async (req, res) => {

        const provider =
            normalizeProvider(
                req.params.provider
            );

        const icao =
            normalizeICAO(
                req.params.icao
            );

        if (!provider) {

            return res.status(400).json({
                available: false,
                error:
                    "Provider must be LIDO or FAA."
            });
        }

        if (!isValidICAO(icao)) {

            return res.status(400).json({
                available: false,
                error:
                    "Invalid ICAO. Example: EHAM."
            });
        }

        try {

            console.log(
                `[CHART INDEX] ${provider} ${icao}`
            );

            const result =
                await createMSFSRequest(
                    "GET_CHART_INDEX",
                    {
                        provider,
                        icao
                    }
                );

            res.json({

                available: true,

                provider,

                icao,

                index: result
            });

        } catch (error) {

            console.error(
                "[CHART INDEX ERROR]",
                error
            );

            res.status(502).json({

                available: false,

                provider,

                icao,

                error: error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| GET CHART PAGES
|--------------------------------------------------------------------------
|
| Example:
|
| GET /api/charts/pages/GUID
|
*/

app.get(
    "/api/charts/pages/:guid",
    async (req, res) => {

        const guid =
            String(
                req.params.guid || ""
            ).trim();

        if (!guid) {

            return res.status(400).json({
                available: false,
                error:
                    "Chart GUID is required."
            });
        }

        try {

            console.log(
                `[CHART PAGES] ${guid}`
            );

            const result =
                await createMSFSRequest(
                    "GET_CHART_PAGES",
                    {
                        guid
                    }
                );

            res.json({

                available: true,

                guid,

                pages: result
            });

        } catch (error) {

            console.error(
                "[CHART PAGES ERROR]",
                error
            );

            res.status(502).json({

                available: false,

                guid,

                error: error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| GET CHART IMAGE
|--------------------------------------------------------------------------
|
| The MSFS-side add-on receives the URL and resolves the chart image
| using ChartView / the MSFS Charts API.
|
*/

app.get(
    "/api/charts/image",
    async (req, res) => {

        const url =
            String(
                req.query.url || ""
            ).trim();

        if (!url) {

            return res.status(400).json({
                available: false,
                error:
                    "Chart page URL is required."
            });
        }

        try {

            console.log(
                "[CHART IMAGE]"
            );

            const result =
                await createMSFSRequest(
                    "GET_CHART_IMAGE",
                    {
                        url
                    }
                );

            res.json({

                available: true,

                image: result
            });

        } catch (error) {

            console.error(
                "[CHART IMAGE ERROR]",
                error
            );

            res.status(502).json({

                available: false,

                error: error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| GENERIC CHART REQUEST
|--------------------------------------------------------------------------
|
| Useful for future features without having to add a new Express route
| every time.
|
*/

app.post(
    "/api/charts/request",
    async (req, res) => {

        const {
            type,
            provider,
            icao,
            guid,
            url,
            page
        } = req.body || {};

        if (!type) {

            return res.status(400).json({
                available: false,
                error:
                    "Request type is required."
            });
        }

        const normalizedProvider =
            provider
                ? normalizeProvider(provider)
                : undefined;

        const normalizedICAO =
            icao
                ? normalizeICAO(icao)
                : undefined;

        try {

            const result =
                await createMSFSRequest(
                    type,
                    {
                        provider:
                            normalizedProvider,

                        icao:
                            normalizedICAO,

                        guid,

                        url,

                        page
                    }
                );

            res.json({

                available: true,

                result
            });

        } catch (error) {

            console.error(
                "[GENERIC REQUEST ERROR]",
                error
            );

            res.status(502).json({

                available: false,

                error: error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| WEBSOCKET SERVER
|--------------------------------------------------------------------------
*/

const server =
    http.createServer(app);

const websocketServer =
    new WebSocket.Server({
        server,
        path: "/msfs"
    });

/*
|--------------------------------------------------------------------------
| MSFS CONNECTION
|--------------------------------------------------------------------------
*/

websocketServer.on(
    "connection",
    socket => {

        console.log("");
        console.log(
            "=============================================="
        );

        console.log(
            " MSFS 2024 CLIENT CONNECTED"
        );

        console.log(
            "=============================================="
        );

        /*
        |--------------------------------------------------------------------------
        | Replace existing client
        |--------------------------------------------------------------------------
        */

        if (msfsClient) {

            try {

                msfsClient.close(
                    1000,
                    "New MSFS client connected."
                );

            } catch (error) {

                console.error(
                    "Could not close old MSFS client:",
                    error.message
                );
            }
        }

        msfsClient = socket;

        msfsInfo.connected = true;

        msfsInfo.connectedAt =
            nowISO();

        msfsInfo.lastMessageAt =
            nowISO();

        msfsInfo.chartsApi = false;

        /*
        |--------------------------------------------------------------------------
        | Tell MSFS bridge client that connection succeeded
        |--------------------------------------------------------------------------
        */

        try {

            socket.send(
                JSON.stringify({
                    type: "BRIDGE_CONNECTED",

                    bridge: {
                        name:
                            "MSFS 2024 Charts API Bridge",

                        version:
                            BRIDGE_VERSION
                    },

                    serverTime:
                        nowISO()
                })
            );

        } catch (error) {

            console.error(
                "Could not send connection message:",
                error.message
            );
        }

        /*
        |--------------------------------------------------------------------------
        | MESSAGE
        |--------------------------------------------------------------------------
        */

        socket.on(
            "message",
            raw => {

                msfsInfo.lastMessageAt =
                    nowISO();

                let message;

                try {

                    message =
                        JSON.parse(
                            raw.toString()
                        );

                } catch (error) {

                    console.error(
                        "Invalid JSON from MSFS:",
                        error.message
                    );

                    return;
                }

                /*
                |--------------------------------------------------------------------------
                | RESPONSE
                |--------------------------------------------------------------------------
                */

                if (
                    message.type ===
                    "RESPONSE"
                ) {

                    const request =
                        pendingRequests.get(
                            message.id
                        );

                    if (!request) {

                        console.warn(
                            `Received response for unknown request ${message.id}`
                        );

                        return;
                    }

                    clearTimeout(
                        request.timeout
                    );

                    pendingRequests.delete(
                        message.id
                    );

                    if (
                        message.success
                    ) {

                        request.resolve(
                            message.data
                        );

                    } else {

                        request.reject(
                            new Error(
                                message.error ||
                                "MSFS Charts API request failed."
                            )
                        );
                    }

                    return;
                }

                /*
                |--------------------------------------------------------------------------
                | MSFS READY
                |--------------------------------------------------------------------------
                */

                if (
                    message.type ===
                    "MSFS_READY"
                ) {

                    msfsInfo.chartsApi =
                        true;

                    console.log(
                        "MSFS Charts API is ready."
                    );

                    try {

                        socket.send(
                            JSON.stringify({
                                type:
                                    "BRIDGE_READY",

                                bridgeVersion:
                                    BRIDGE_VERSION
                            })
                        );

                    } catch (error) {

                        console.error(
                            "Could not send BRIDGE_READY:",
                            error.message
                        );
                    }

                    return;
                }

                /*
                |--------------------------------------------------------------------------
                | PONG
                |--------------------------------------------------------------------------
                */

                if (
                    message.type ===
                    "PONG"
                ) {

                    return;
                }

                /*
                |--------------------------------------------------------------------------
                | LOG
                |--------------------------------------------------------------------------
                */

                if (
                    message.type ===
                    "LOG"
                ) {

                    console.log(
                        "[MSFS]",
                        message.message ||
                        ""
                    );

                    return;
                }

                /*
                |--------------------------------------------------------------------------
                | UNKNOWN
                |--------------------------------------------------------------------------
                */

                console.log(
                    "[MSFS MESSAGE]",
                    message
                );
            }
        );

        /*
        |--------------------------------------------------------------------------
        | CLOSE
        |--------------------------------------------------------------------------
        */

        socket.on(
            "close",
            (code, reason) => {

                console.log(
                    `MSFS client disconnected. Code: ${code}`
                );

                if (reason) {

                    console.log(
                        `Reason: ${reason.toString()}`
                    );
                }

                if (
                    msfsClient === socket
                ) {

                    msfsClient = null;

                    msfsInfo.connected =
                        false;

                    msfsInfo.chartsApi =
                        false;
                }

                rejectPendingRequests(
                    "MSFS 2024 disconnected."
                );
            }
        );

        /*
        |--------------------------------------------------------------------------
        | ERROR
        |--------------------------------------------------------------------------
        */

        socket.on(
            "error",
            error => {

                console.error(
                    "MSFS WebSocket error:",
                    error.message
                );
            }
        );
    }
);

/*
|--------------------------------------------------------------------------
| REJECT PENDING REQUESTS
|--------------------------------------------------------------------------
*/

function rejectPendingRequests(
    reason
) {

    for (
        const [id, request]
        of pendingRequests
    ) {

        clearTimeout(
            request.timeout
        );

        request.reject(
            new Error(reason)
        );

        pendingRequests.delete(
            id
        );
    }
}

/*
|--------------------------------------------------------------------------
| PERIODIC PING
|--------------------------------------------------------------------------
*/

setInterval(() => {

    if (
        !msfsClient ||
        msfsClient.readyState !== WebSocket.OPEN
    ) {
        return;
    }

    try {

        msfsClient.send(
            JSON.stringify({
                type: "PING"
            })
        );

    } catch (error) {

        console.error(
            "MSFS ping failed:",
            error.message
        );
    }

}, 15000);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use(
    (req, res) => {

        res.status(404).json({

            available: false,

            error:
                "MSFS Charts Bridge endpoint not found.",

            path:
                req.originalUrl
        });
    }
);

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use(
    (error, req, res, next) => {

        console.error(
            "Bridge server error:",
            error
        );

        res.status(500).json({

            available: false,

            error:
                "Internal bridge server error."
        });
    }
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

server.listen(
    PORT,
    HOST,
    () => {

        console.log("");
        console.log(
            "=================================================="
        );

        console.log(
            "       MSFS 2024 CHARTS API BRIDGE"
        );

        console.log(
            "=================================================="
        );

        console.log(
            ` HTTP:      http://${HOST}:${PORT}`
        );

        console.log(
            ` WebSocket: ws://${HOST}:${PORT}/msfs`
        );

        console.log(
            " MSFS:      Waiting for connection..."
        );

        console.log(
            " Providers: LIDO / FAA"
        );

        console.log(
            ` Version:   ${BRIDGE_VERSION}`
        );

        console.log(
            "=================================================="
        );

        console.log("");
    }
);

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
*/

function shutdown(signal) {

    console.log(
        `Received ${signal}. Shutting down...`
    );

    rejectPendingRequests(
        "Bridge shutting down."
    );

    if (msfsClient) {

        try {

            msfsClient.close(
                1000,
                "Bridge shutting down."
            );

        } catch (error) {

            console.error(
                "Error closing MSFS connection:",
                error.message
            );
        }
    }

    websocketServer.close(
        () => {

            server.close(
                () => {

                    process.exit(0);
                }
            );
        }
    );
}

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);
