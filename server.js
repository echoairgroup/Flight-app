/*
|--------------------------------------------------------------------------
| ECHO FLIGHT APP
| MSFS 2024 CHARTS ONLINE BRIDGE
|--------------------------------------------------------------------------
|
| Architecture:
|
|   Echo Flight App
|          |
|          | HTTPS
|          v
|   Render Charts Bridge
|          |
|          | WSS
|          v
|   MSFS 2024 Charts Add-on
|          |
|          v
|   MSFS Charts API
|
|--------------------------------------------------------------------------
*/

const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

/*
|--------------------------------------------------------------------------
| CONFIGURATION
|--------------------------------------------------------------------------
*/

const PORT = Number(process.env.PORT || 10000);

const HOST = "0.0.0.0";

const VERSION = "1.0.0";

const REQUEST_TIMEOUT = 30000;

const SERVICE_NAME =
    "Echo Flight App - MSFS 2024 Charts Bridge";

/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

const app = express();

app.use(
    cors({
        origin: true,
        methods: [
            "GET",
            "POST",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ]
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

/*
 * MSFS clients are stored by connection ID.
 *
 * We deliberately support multiple connections here instead of assuming
 * that only one MSFS installation will ever be connected.
 *
 * This also gives us a better architecture for future scaling.
 */

const msfsClients = new Map();

/*
 * Every request from the website receives an ID.
 *
 * Example:
 *
 * Browser
 *   request 123
 *
 * Render
 *   request 123 -> MSFS
 *
 * MSFS
 *   response 123 -> Render
 *
 * Render
 *   response 123 -> Browser
 */

let requestCounter = 0;

const pendingRequests = new Map();

/*
|--------------------------------------------------------------------------
| CONNECTION INFORMATION
|--------------------------------------------------------------------------
*/

function createConnectionId() {
    return (
        `${Date.now()}-` +
        `${Math.random().toString(36).slice(2, 10)}`
    );
}

/*
|--------------------------------------------------------------------------
| TIME
|--------------------------------------------------------------------------
*/

function now() {
    return new Date().toISOString();
}

/*
|--------------------------------------------------------------------------
| ICAO
|--------------------------------------------------------------------------
*/

function normalizeICAO(value) {

    return String(value || "")
        .trim()
        .toUpperCase();
}

function isValidICAO(value) {

    return /^[A-Z]{4}$/.test(value);
}

/*
|--------------------------------------------------------------------------
| PROVIDER
|--------------------------------------------------------------------------
*/

function normalizeProvider(value) {

    const provider =
        String(value || "")
            .trim()
            .toUpperCase();

    if (provider === "LIDO") {
        return "LIDO";
    }

    if (provider === "FAA") {
        return "FAA";
    }

    return null;
}

/*
|--------------------------------------------------------------------------
| GET CONNECTED MSFS CLIENTS
|--------------------------------------------------------------------------
*/

function getConnectedClients() {

    return [
        ...msfsClients.values()
    ].filter(client => {

        return (
            client.socket.readyState ===
            WebSocket.OPEN
        );
    });
}

/*
|--------------------------------------------------------------------------
| SELECT MSFS CLIENT
|--------------------------------------------------------------------------
|
| For now, if multiple MSFS clients are connected, the newest client
| is used.
|
| Later we can add:
|
|   user authentication
|   Discord account linking
|   pilot IDs
|   session IDs
|   browser pairing
|
|--------------------------------------------------------------------------
*/

function getMSFSClient() {

    const clients =
        getConnectedClients();

    if (clients.length === 0) {
        return null;
    }

    clients.sort(
        (a, b) =>
            b.connectedAt - a.connectedAt
    );

    return clients[0];
}

/*
|--------------------------------------------------------------------------
| SEND MESSAGE TO MSFS
|--------------------------------------------------------------------------
*/

function sendToMSFS(
    client,
    message
) {

    if (!client) {

        throw new Error(
            "No Microsoft Flight Simulator 2024 client is connected."
        );
    }

    if (
        client.socket.readyState !==
        WebSocket.OPEN
    ) {

        throw new Error(
            "MSFS WebSocket connection is not open."
        );
    }

    client.socket.send(
        JSON.stringify(message)
    );
}

/*
|--------------------------------------------------------------------------
| CREATE MSFS REQUEST
|--------------------------------------------------------------------------
*/

function requestMSFS(
    type,
    payload = {}
) {

    return new Promise(
        (resolve, reject) => {

            const client =
                getMSFSClient();

            if (!client) {

                reject(
                    new Error(
                        "Microsoft Flight Simulator 2024 is offline."
                    )
                );

                return;
            }

            const id =
                ++requestCounter;

            const timeout =
                setTimeout(
                    () => {

                        pendingRequests.delete(
                            id
                        );

                        reject(
                            new Error(
                                `MSFS request timed out after ${REQUEST_TIMEOUT / 1000} seconds.`
                            )
                        );

                    },
                    REQUEST_TIMEOUT
                );

            pendingRequests.set(
                id,
                {
                    resolve,
                    reject,
                    timeout,
                    clientId:
                        client.id,
                    type,
                    createdAt:
                        Date.now()
                }
            );

            try {

                sendToMSFS(
                    client,
                    {
                        type,
                        id,
                        ...payload
                    }
                );

            } catch (error) {

                clearTimeout(
                    timeout
                );

                pendingRequests.delete(
                    id
                );

                reject(error);
            }
        }
    );
}

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
    "/health",
    (req, res) => {

        res.status(200).json({

            status: "ok",

            service:
                SERVICE_NAME,

            version:
                VERSION,

            time:
                now()
        });
    }
);

/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get(
    "/",
    (req, res) => {

        res.json({

            service:
                SERVICE_NAME,

            status:
                "online",

            version:
                VERSION,

            msfsClients:
                getConnectedClients().length,

            endpoints: {

                health:
                    "/health",

                status:
                    "/api/status",

                charts:
                    "/api/charts/:provider/:icao",

                pages:
                    "/api/charts/pages/:guid",

                image:
                    "/api/charts/image",

                generic:
                    "/api/charts/request"
            }
        });
    }
);

/*
|--------------------------------------------------------------------------
| STATUS
|--------------------------------------------------------------------------
*/

app.get(
    "/api/status",
    (req, res) => {

        const clients =
            getConnectedClients();

        res.json({

            available:
                true,

            bridge: {

                online:
                    true,

                name:
                    SERVICE_NAME,

                version:
                    VERSION
            },

            msfs: {

                connected:
                    clients.length > 0,

                clients:
                    clients.length,

                chartsApi:
                    clients.some(
                        client =>
                            client.chartsApi === true
                    )
            },

            providers: {

                LIDO:
                    clients.length > 0,

                FAA:
                    clients.length > 0
            },

            timestamp:
                now()
        });
    }
);

/*
|--------------------------------------------------------------------------
| GET CHART INDEX
|--------------------------------------------------------------------------
|
| GET:
|
| /api/charts/LIDO/EHAM
|
| /api/charts/FAA/KJFK
|
|--------------------------------------------------------------------------
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

                available:
                    false,

                error:
                    "Provider must be LIDO or FAA."
            });
        }

        if (!isValidICAO(icao)) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Invalid ICAO code."
            });
        }

        try {

            console.log(
                `[CHART INDEX] ${provider} ${icao}`
            );

            const result =
                await requestMSFS(
                    "GET_CHART_INDEX",
                    {
                        provider,
                        icao
                    }
                );

            res.json({

                available:
                    true,

                provider,

                icao,

                index:
                    result,

                timestamp:
                    now()
            });

        } catch (error) {

            console.error(
                "[CHART INDEX ERROR]",
                error.message
            );

            res.status(502).json({

                available:
                    false,

                provider,

                icao,

                error:
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| GET CHART PAGES
|--------------------------------------------------------------------------
|
| GET:
|
| /api/charts/pages/<GUID>
|
|--------------------------------------------------------------------------
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

                available:
                    false,

                error:
                    "Chart GUID is required."
            });
        }

        try {

            console.log(
                `[CHART PAGES] ${guid}`
            );

            const result =
                await requestMSFS(
                    "GET_CHART_PAGES",
                    {
                        guid
                    }
                );

            res.json({

                available:
                    true,

                guid,

                pages:
                    result,

                timestamp:
                    now()
            });

        } catch (error) {

            console.error(
                "[CHART PAGES ERROR]",
                error.message
            );

            res.status(502).json({

                available:
                    false,

                guid,

                error:
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| GET CHART IMAGE
|--------------------------------------------------------------------------
|
| The MSFS add-on resolves the chart image using the MSFS Charts API.
|
| The browser does NOT directly access the MSFS chart system.
|
|--------------------------------------------------------------------------
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

                available:
                    false,

                error:
                    "Chart page URL is required."
            });
        }

        try {

            const result =
                await requestMSFS(
                    "GET_CHART_IMAGE",
                    {
                        url
                    }
                );

            res.json({

                available:
                    true,

                image:
                    result,

                timestamp:
                    now()
            });

        } catch (error) {

            console.error(
                "[CHART IMAGE ERROR]",
                error.message
            );

            res.status(502).json({

                available:
                    false,

                error:
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| GENERIC MSFS CHART REQUEST
|--------------------------------------------------------------------------
*/

app.post(
    "/api/charts/request",
    async (req, res) => {

        const body =
            req.body || {};

        const type =
            body.type;

        if (!type) {

            return res.status(400).json({

                available:
                    false,

                error:
                    "Request type is required."
            });
        }

        try {

            const result =
                await requestMSFS(
                    type,
                    {
                        provider:
                            body.provider,

                        icao:
                            body.icao,

                        guid:
                            body.guid,

                        url:
                            body.url,

                        page:
                            body.page,

                        airport:
                            body.airport
                    }
                );

            res.json({

                available:
                    true,

                result,

                timestamp:
                    now()
            });

        } catch (error) {

            console.error(
                "[CHART REQUEST ERROR]",
                error.message
            );

            res.status(502).json({

                available:
                    false,

                error:
                    error.message
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
    http.createServer(
        app
    );

const websocketServer =
    new WebSocket.Server({
        server,
        path: "/msfs"
    });

/*
|--------------------------------------------------------------------------
| MSFS WEBSOCKET CONNECTION
|--------------------------------------------------------------------------
*/

websocketServer.on(
    "connection",
    (socket, request) => {

        const id =
            createConnectionId();

        const client = {

            id,

            socket,

            connectedAt:
                Date.now(),

            connectedAtISO:
                now(),

            chartsApi:
                false,

            simulator:
                "Microsoft Flight Simulator 2024",

            lastMessageAt:
                now(),

            ip:
                request.socket
                    ?.remoteAddress ||
                null
        };

        msfsClients.set(
            id,
            client
        );

        console.log("");
        console.log(
            "=============================================="
        );

        console.log(
            " MSFS 2024 CLIENT CONNECTED"
        );

        console.log(
            ` ID: ${id}`
        );

        console.log(
            ` Clients: ${msfsClients.size}`
        );

        console.log(
            "=============================================="
        );

        /*
        |--------------------------------------------------------------------------
        | HELLO
        |--------------------------------------------------------------------------
        */

        socket.send(
            JSON.stringify({

                type:
                    "BRIDGE_CONNECTED",

                bridge: {

                    name:
                        SERVICE_NAME,

                    version:
                        VERSION
                },

                connectionId:
                    id,

                serverTime:
                    now(),

                protocolVersion:
                    "1.0"
            })
        );

        /*
        |--------------------------------------------------------------------------
        | MESSAGE
        |--------------------------------------------------------------------------
        */

        socket.on(
            "message",
            raw => {

                client.lastMessageAt =
                    now();

                let message;

                try {

                    message =
                        JSON.parse(
                            raw.toString()
                        );

                } catch (error) {

                    console.error(
                        "Invalid JSON received from MSFS:",
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
                            `Unknown request ID: ${message.id}`
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
                                "MSFS request failed."
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

                    client.chartsApi =
                        true;

                    if (
                        message.simulator
                    ) {

                        client.simulator =
                            message.simulator;
                    }

                    console.log(
                        `[MSFS READY] ${id}`
                    );

                    socket.send(
                        JSON.stringify({

                            type:
                                "BRIDGE_READY",

                            connectionId:
                                id,

                            bridgeVersion:
                                VERSION,

                            timestamp:
                                now()
                        })
                    );

                    return;
                }

                /*
                |--------------------------------------------------------------------------
                | PING
                |--------------------------------------------------------------------------
                */

                if (
                    message.type ===
                    "PING"
                ) {

                    socket.send(
                        JSON.stringify({

                            type:
                                "PONG",

                            timestamp:
                                now()
                        })
                    );

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
                        `[MSFS ${id}]`,
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
                    `[MSFS MESSAGE ${id}]`,
                    message
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
                    `[MSFS ERROR ${id}]`,
                    error.message
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
                    `[MSFS DISCONNECTED] ${id}`
                );

                console.log(
                    `Code: ${code}`
                );

                if (reason) {

                    console.log(
                        `Reason: ${reason.toString()}`
                    );
                }

                /*
                |--------------------------------------------------------------------------
                | Reject requests belonging to this client
                |--------------------------------------------------------------------------
                */

                for (
                    const [
                        requestId,
                        request
                    ]
                    of pendingRequests
                ) {

                    if (
                        request.clientId === id
                    ) {

                        clearTimeout(
                            request.timeout
                        );

                        request.reject(
                            new Error(
                                "MSFS 2024 disconnected."
                            )
                        );

                        pendingRequests.delete(
                            requestId
                        );
                    }
                }

                msfsClients.delete(
                    id
                );
            }
        );
    }
);

/*
|--------------------------------------------------------------------------
| HEARTBEAT
|--------------------------------------------------------------------------
|
| Render recommends keeping WebSocket connections alive and detecting
| stale connections. We use WebSocket ping frames here.
|--------------------------------------------------------------------------
*/

const heartbeatInterval =
    setInterval(
        () => {

            for (
                const [
                    id,
                    client
                ]
                of msfsClients
            ) {

                if (
                    client.socket.readyState !==
                    WebSocket.OPEN
                ) {

                    continue;
                }

                try {

                    client.socket.ping();

                } catch (error) {

                    console.error(
                        `[HEARTBEAT ERROR ${id}]`,
                        error.message
                    );
                }
            }

        },
        30000
    );

/*
|--------------------------------------------------------------------------
| CLEANUP
|--------------------------------------------------------------------------
*/

function cleanup() {

    clearInterval(
        heartbeatInterval
    );

    /*
    |--------------------------------------------------------------------------
    | Reject pending requests
    |--------------------------------------------------------------------------
    */

    for (
        const [
            requestId,
            request
        ]
        of pendingRequests
    ) {

        clearTimeout(
            request.timeout
        );

        request.reject(
            new Error(
                "Charts bridge shutting down."
            )
        );

        pendingRequests.delete(
            requestId
        );
    }

    /*
    |--------------------------------------------------------------------------
    | Close MSFS clients
    |--------------------------------------------------------------------------
    */

    for (
        const client
        of msfsClients.values()
    ) {

        try {

            client.socket.close(
                1001,
                "Charts bridge shutting down."
            );

        } catch (error) {

            console.error(
                "Error closing MSFS socket:",
                error.message
            );
        }
    }

    msfsClients.clear();
}

/*
|--------------------------------------------------------------------------
| SHUTDOWN
|--------------------------------------------------------------------------
*/

function shutdown(signal) {

    console.log(
        `Received ${signal}.`
    );

    cleanup();

    websocketServer.close(
        () => {

            server.close(
                () => {

                    process.exit(0);
                }
            );
        }
    );

    /*
    |--------------------------------------------------------------------------
    | Safety timeout
    |--------------------------------------------------------------------------
    */

    setTimeout(
        () => {

            process.exit(0);

        },
        10000
    ).unref();
}

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

server.listen(
    PORT,
    HOST,
    () => {

        console.log("");
        console.log(
            "======================================================"
        );

        console.log(
            "       ECHO FLIGHT APP"
        );

        console.log(
            "       MSFS 2024 CHARTS ONLINE BRIDGE"
        );

        console.log(
            "======================================================"
        );

        console.log(
            ` HTTP:      http://0.0.0.0:${PORT}`
        );

        console.log(
            ` WebSocket: ws://0.0.0.0:${PORT}/msfs`
        );

        console.log(
            " Render:    READY"
        );

        console.log(
            " MSFS:      WAITING"
        );

        console.log(
            " Providers: LIDO / FAA"
        );

        console.log(
            ` Version:   ${VERSION}`
        );

        console.log(
            "======================================================"
        );

        console.log("");
    }
);
