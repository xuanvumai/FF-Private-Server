
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const BODY_LIMIT = 8192;
const SESSION_BYTES = 32;

function createServer() {
    const accounts = new Map();
    const sessions = new Map();
    const queue = new Map();
    const matchedPlayers = new Map();
    const rooms = new Map();
    const matches = new Map();

    function send(res, status, data) {
        if (res.destroyed || res.writableEnded) return;

        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });

        res.end(JSON.stringify(data));
    }

    async function readBody(req) {
        const chunks = [];
        let size = 0;

        for await (const chunk of req) {
            size += chunk.length;

            if (size > BODY_LIMIT) {
                const error = new Error('BODY_TOO_LARGE');
                error.status = 413;
                throw error;
            }

            chunks.push(chunk);
        }

        if (size === 0) return {};

        let body;

        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            const error = new Error('INVALID_JSON');
            error.status = 400;
            throw error;
        }

        if (
            body === null ||
            typeof body !== 'object' ||
            Array.isArray(body)
        ) {
            const error = new Error('INVALID_BODY');
            error.status = 400;
            throw error;
        }

        return body;
    }

    function getUser(req) {
        const header = req.headers.authorization || '';

        if (!header.startsWith('Bearer ')) return null;

        const token = header.slice(7).trim();

        if (!token) return null;

        return sessions.get(token) || null;
    }

    function hashPassword(password, salt) {
        return crypto.scryptSync(password, salt, 64).toString('hex');
    }

    function createSession(username) {
        const token = crypto.randomBytes(SESSION_BYTES).toString('hex');
        sessions.set(token, username);
        return token;
    }

    function makeMatch(players, roomId = null) {
        const match = {
            id: crypto.randomUUID(),
            roomId,
            players: [...players],
            status: 'started',
            winner: null,
            createdAt: new Date().toISOString(),
            finishedAt: null
        };

        matches.set(match.id, match);

        return match;
    }

    function removePlayerFromQueue(username) {
        queue.delete(username);
        matchedPlayers.delete(username);
    }

    const app = http.createServer(async (req, res) => {
        let path;

        try {
            const url = new URL(
                req.url || '/',
                'http://localhost'
            );

            path = url.pathname;

            const method = req.method || 'GET';

            // ROOT
            if (method === 'GET' && path === '/') {
                return send(res, 200, {
                    name: 'FF Private Backend',
                    version: '3.1.0',
                    status: 'online'
                });
            }

            // HEALTH
            if (method === 'GET' && path === '/health') {
                return send(res, 200, {
                    status: 'online',
                    version: '3.1.0',
                    node: process.version,
                    modules: [
                        'account',
                        'lobby',
                        'matchmaking',
                        'rooms',
                        'matches'
                    ]
                });
            }

            // REGISTER
            if (method === 'POST' && path === '/api/register') {
                const body = await readBody(req);

                const username = String(body.username || '')
                    .trim()
                    .toLowerCase();

                if (!/^[a-z0-9_]{3,20}$/.test(username)) {
                    return send(res, 400, {
                        error: 'INVALID_USERNAME'
                    });
                }

                if (
                    typeof body.password !== 'string' ||
                    body.password.length < 8 ||
                    body.password.length > 128
                ) {
                    return send(res, 400, {
                        error: 'INVALID_PASSWORD'
                    });
                }

                if (accounts.has(username)) {
                    return send(res, 409, {
                        error: 'ACCOUNT_EXISTS'
                    });
                }

                const salt = crypto.randomBytes(16).toString('hex');

                accounts.set(username, {
                    username,
                    salt,
                    passwordHash: hashPassword(body.password, salt),
                    createdAt: new Date().toISOString()
                });

                return send(res, 201, {
                    message: 'ACCOUNT_CREATED',
                    token: createSession(username),
                    user: { username }
                });
            }

            // LOGIN
            if (method === 'POST' && path === '/api/login') {
                const body = await readBody(req);

                const username = String(body.username || '')
                    .trim()
                    .toLowerCase();

                const account = accounts.get(username);

                if (
                    !account ||
                    typeof body.password !== 'string' ||
                    body.password.length < 8 ||
                    body.password.length > 128
                ) {
                    return send(res, 401, {
                        error: 'INVALID_CREDENTIALS'
                    });
                }

                const actual = Buffer.from(
                    hashPassword(body.password, account.salt),
                    'hex'
                );

                const expected = Buffer.from(
                    account.passwordHash,
                    'hex'
                );

                if (
                    actual.length !== expected.length ||
                    !crypto.timingSafeEqual(actual, expected)
                ) {
                    return send(res, 401, {
                        error: 'INVALID_CREDENTIALS'
                    });
                }

                return send(res, 200, {
                    message: 'LOGIN_SUCCESS',
                    token: createSession(username),
                    user: { username }
                });
            }

            // AUTHENTICATION
            const username = getUser(req);

            if (!username) {
                return send(res, 401, {
                    error: 'UNAUTHORIZED'
                });
            }

            // PROFILE
            if (method === 'GET' && path === '/api/me') {
                const account = accounts.get(username);

                if (!account) {
                    return send(res, 404, {
                        error: 'ACCOUNT_NOT_FOUND'
                    });
                }

                return send(res, 200, {
                    username,
                    createdAt: account.createdAt
                });
            }

            // LOGOUT
            if (method === 'POST' && path === '/api/logout') {
                const token = req.headers.authorization.slice(7).trim();

                sessions.delete(token);
                removePlayerFromQueue(username);

                for (const room of rooms.values()) {
                    if (!room.players.includes(username)) continue;

                    if (room.host === username) {
                        room.status = 'closed';
                        room.players = [];
                    } else {
                        room.players = room.players.filter(
                            player => player !== username
                        );
                    }
                }

                return send(res, 200, {
                    message: 'LOGOUT_SUCCESS'
                });
            }

            // LOBBY
            if (method === 'GET' && path === '/api/lobby') {
                const online = [...new Set(sessions.values())];

                return send(res, 200, {
                    onlineCount: online.length,
                    players: online.map(name => ({
                        username: name
                    }))
                });
            }

            // CREATE ROOM
            if (method === 'POST' && path === '/api/rooms') {
                const body = await readBody(req);
                const name = String(body.name || '').trim();

                const maxPlayers = body.maxPlayers === undefined
                    ? 2
                    : Number(body.maxPlayers);

                if (name.length < 3 || name.length > 30) {
                    return send(res, 400, {
                        error: 'INVALID_ROOM_NAME'
                    });
                }

                if (
                    !Number.isInteger(maxPlayers) ||
                    maxPlayers < 2 ||
                    maxPlayers > 4
                ) {
                    return send(res, 400, {
                        error: 'INVALID_PLAYER_LIMIT'
                    });
                }

                const room = {
                    id: crypto.randomUUID(),
                    name,
                    host: username,
                    players: [username],
                    maxPlayers,
                    status: 'waiting',
                    createdAt: new Date().toISOString(),
                    matchId: null
                };

                rooms.set(room.id, room);

                return send(res, 201, {
                    message: 'ROOM_CREATED',
                    room
                });
            }

            // LIST ROOMS
            if (method === 'GET' && path === '/api/rooms') {
                return send(res, 200, {
                    rooms: [...rooms.values()]
                        .filter(room => room.status !== 'closed')
                });
            }

            // JOIN ROOM
            const joinRoom = path.match(
                /^\/api\/rooms\/([a-f0-9-]+)\/join$/
            );

            if (method === 'POST' && joinRoom) {
                const room = rooms.get(joinRoom[1]);

                if (!room || room.status === 'closed') {
                    return send(res, 404, {
                        error: 'ROOM_NOT_FOUND'
                    });
                }

                if (room.status !== 'waiting') {
                    return send(res, 409, {
                        error: 'ROOM_ALREADY_STARTED'
                    });
                }

                if (room.players.includes(username)) {
                    return send(res, 200, { room });
                }

                if (room.players.length >= room.maxPlayers) {
                    return send(res, 409, {
                        error: 'ROOM_FULL'
                    });
                }

                room.players.push(username);

                return send(res, 200, {
                    message: 'ROOM_JOINED',
                    room
                });
            }

            // LEAVE ROOM
            const leaveRoom = path.match(
                /^\/api\/rooms\/([a-f0-9-]+)\/leave$/
            );

            if (method === 'POST' && leaveRoom) {
                const room = rooms.get(leaveRoom[1]);

                if (!room || !room.players.includes(username)) {
                    return send(res, 404, {
                        error: 'ROOM_NOT_FOUND'
                    });
                }

                if (room.host === username) {
                    room.status = 'closed';
                    room.players = [];
                } else {
                    room.players = room.players.filter(
                        player => player !== username
                    );
                }

                return send(res, 200, {
                    message: 'ROOM_LEFT'
                });
            }

            // START ROOM MATCH
            const startRoom = path.match(
                /^\/api\/rooms\/([a-f0-9-]+)\/start$/
            );

            if (method === 'POST' && startRoom) {
                const room = rooms.get(startRoom[1]);

                if (!room || room.status !== 'waiting') {
                    return send(res, 404, {
                        error: 'ROOM_NOT_AVAILABLE'
                    });
                }

                if (room.host !== username) {
                    return send(res, 403, {
                        error: 'HOST_ONLY'
                    });
                }

                if (room.players.length < 2) {
                    return send(res, 409, {
                        error: 'NOT_ENOUGH_PLAYERS'
                    });
                }

                const match = makeMatch(
                    room.players,
                    room.id
                );

                room.status = 'started';
                room.matchId = match.id;

                return send(res, 200, {
                    message: 'MATCH_STARTED',
                    match
                });
            }

            // MATCHMAKING JOIN
            if (
                method === 'POST' &&
                path === '/api/matchmaking/join'
            ) {
                const existingMatchId = matchedPlayers.get(username);

                if (existingMatchId) {
                    const existingMatch = matches.get(existingMatchId);

                    if (
                        existingMatch &&
                        existingMatch.status === 'started'
                    ) {
                        return send(res, 200, {
                            status: 'matched',
                            match: existingMatch
                        });
                    }

                    matchedPlayers.delete(username);
                }

                if (queue.has(username)) {
                    return send(res, 200, {
                        status: 'waiting'
                    });
                }

                queue.set(username, Date.now());

                if (queue.size >= 2) {
                    const players = [...queue.keys()].slice(0, 2);

                    for (const player of players) {
                        queue.delete(player);
                    }

                    const match = makeMatch(players);

                    for (const player of players) {
                        matchedPlayers.set(player, match.id);
                    }

                    return send(res, 200, {
                        status: 'matched',
                        match
                    });
                }

                return send(res, 200, {
                    status: 'waiting'
                });
            }

            // MATCHMAKING LEAVE
            if (
                method === 'POST' &&
                path === '/api/matchmaking/leave'
            ) {
                removePlayerFromQueue(username);

                return send(res, 200, {
                    message: 'QUEUE_LEFT'
                });
            }

            // MATCH DETAILS
            const matchRoute = path.match(
                /^\/api\/matches\/([a-f0-9-]+)$/
            );

            if (method === 'GET' && matchRoute) {
                const match = matches.get(matchRoute[1]);

                if (!match || !match.players.includes(username)) {
                    return send(res, 404, {
                        error: 'MATCH_NOT_FOUND'
                    });
                }

                return send(res, 200, { match });
            }

            // FINISH MATCH
            const finishMatch = path.match(
                /^\/api\/matches\/([a-f0-9-]+)\/finish$/
            );

            if (method === 'POST' && finishMatch) {
                const match = matches.get(finishMatch[1]);

                if (!match || !match.players.includes(username)) {
                    return send(res, 404, {
                        error: 'MATCH_NOT_FOUND'
                    });
                }

                if (match.status === 'completed') {
                    return send(res, 409, {
                        error: 'MATCH_ALREADY_FINISHED'
                    });
                }

                const body = await readBody(req);

                if (
                    typeof body.winner !== 'string' ||
                    !match.players.includes(body.winner)
                ) {
                    return send(res, 400, {
                        error: 'INVALID_WINNER'
                    });
                }

                match.status = 'completed';
                match.winner = body.winner;
                match.finishedAt = new Date().toISOString();

                for (const player of match.players) {
                    if (matchedPlayers.get(player) === match.id) {
                        matchedPlayers.delete(player);
                    }
                }

                return send(res, 200, {
                    message: 'MATCH_COMPLETED',
                    match
                });
            }

            return send(res, 404, {
                error: 'NOT_FOUND'
            });

        } catch (error) {
            if (res.destroyed || res.writableEnded) return;

            if (error.message === 'BODY_TOO_LARGE') {
                return send(res, 413, {
                    error: 'BODY_TOO_LARGE'
                });
            }

            if (error.message === 'INVALID_JSON') {
                return send(res, 400, {
                    error: 'INVALID_JSON'
                });
            }

            if (error.message === 'INVALID_BODY') {
                return send(res, 400, {
                    error: 'INVALID_BODY'
                });
            }

            console.error('[FF Backend Error]', error);

            return send(res, 500, {
                error: 'INTERNAL_SERVER_ERROR'
            });
        }
    });

    app.keepAliveTimeout = 5000;
    app.headersTimeout = 10000;
    app.requestTimeout = 15000;

    return app;
}

const server = createServer();

if (require.main === module) {
    const port = Number(process.env.PORT || 3000);

    if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        console.error('Invalid PORT environment variable');
        process.exit(1);
    }

    server.listen(port, '0.0.0.0', () => {
        console.log(
            `FF Backend v3.1.0 running on port ${port}`
        );
        console.log(`Node.js ${process.version}`);
    });

    function shutdown(signal) {
        console.log(`${signal} received. Closing server...`);

        server.close(error => {
            if (error) {
                console.error('Server shutdown error:', error);
                process.exit(1);
            }

            console.log('Server stopped.');
            process.exit(0);
        });

        setTimeout(() => {
            console.error('Forced shutdown.');
            process.exit(1);
        }, 10000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createServer };
