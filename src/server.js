
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

function createServer(options = {}) {
    const accounts = new Map();
    const sessions = new Map();
    const queue = new Map();
    const rooms = new Map();
    const matches = new Map();

    const MAX_BODY = 8192;
    const PORT = Number(options.port || process.env.PORT || 3000);

    function send(res, status, data) {
        if (res.writableEnded) return;

        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        });

        res.end(JSON.stringify(data));
    }

    function createId() {
        return crypto.randomUUID();
    }

    function hashPassword(password, salt) {
        return crypto.scryptSync(password, salt, 64).toString('hex');
    }

    function readBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            let size = 0;

            req.on('data', chunk => {
                size += chunk.length;

                if (size > MAX_BODY) {
                    reject(new Error('BODY_TOO_LARGE'));
                    req.destroy();
                    return;
                }

                body += chunk.toString();
            });

            req.on('end', () => {
                if (!body) return resolve({});

                try {
                    const parsed = JSON.parse(body);

                    if (!parsed || typeof parsed !== 'object' ||
                        Array.isArray(parsed)) {
                        return reject(new Error('INVALID_JSON'));
                    }

                    resolve(parsed);
                } catch {
                    reject(new Error('INVALID_JSON'));
                }
            });

            req.on('error', reject);
        });
    }

    function getUser(req) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ')
            ? header.slice(7)
            : null;

        return token ? sessions.get(token) || null : null;
    }

    function requireAuth(req, res) {
        const user = getUser(req);

        if (!user) {
            send(res, 401, {
                success: false,
                error: 'UNAUTHORIZED'
            });
            return null;
        }

        return user;
    }

    function publicUser(user) {
        return {
            id: user.id,
            username: user.username
        };
    }

    function roomInfo(room) {
        return {
            id: room.id,
            name: room.name,
            owner: room.owner,
            players: room.players,
            maxPlayers: room.maxPlayers,
            status: room.status
        };
    }

    function removeFromQueue(userId) {
        queue.delete(userId);
    }

    function createMatch(players, roomId = null) {
        const match = {
            id: createId(),
            players: [...players],
            roomId,
            status: 'active',
            createdAt: Date.now(),
            finishedAt: null
        };

        matches.set(match.id, match);

        return match;
    }

    async function handler(req, res) {
        let url;

        try {
            url = new URL(req.url, 'http://localhost');
        } catch {
            return send(res, 400, {
                success: false,
                error: 'INVALID_URL'
            });
        }

        const path = url.pathname;
        const method = req.method;

        try {
            // ROOT
            if (path === '/' && method === 'GET') {
                return send(res, 200, {
                    name: 'FF Private Backend',
                    version: '3.2.0',
                    status: 'online',
                    runtime: 'Node.js 24'
                });
            }

            // HEALTH
            if (path === '/health' && method === 'GET') {
                return send(res, 200, {
                    success: true,
                    status: 'healthy',
                    uptime: process.uptime()
                });
            }

            // REGISTER
            if (path === '/api/register' && method === 'POST') {
                const body = await readBody(req);
                const username = body.username;
                const password = body.password;

                if (
                    typeof username !== 'string' ||
                    typeof password !== 'string' ||
                    username.length < 3 ||
                    username.length > 24 ||
                    password.length < 6 ||
                    password.length > 128
                ) {
                    return send(res, 400, {
                        success: false,
                        error: 'INVALID_CREDENTIALS'
                    });
                }

                if (accounts.has(username)) {
                    return send(res, 409, {
                        success: false,
                        error: 'USERNAME_EXISTS'
                    });
                }

                const salt = crypto.randomBytes(16).toString('hex');

                const user = {
                    id: createId(),
                    username,
                    salt,
                    passwordHash: hashPassword(password, salt),
                    createdAt: Date.now()
                };

                accounts.set(username, user);

                return send(res, 201, {
                    success: true,
                    user: publicUser(user)
                });
            }

            // LOGIN
            if (path === '/api/login' && method === 'POST') {
                const body = await readBody(req);
                const { username, password } = body;

                const user = accounts.get(username);

                if (
                    !user ||
                    typeof password !== 'string' ||
                    hashPassword(password, user.salt) !== user.passwordHash
                ) {
                    return send(res, 401, {
                        success: false,
                        error: 'INVALID_LOGIN'
                    });
                }

                const token = crypto.randomBytes(32).toString('hex');

                sessions.set(token, user);

                return send(res, 200, {
                    success: true,
                    token,
                    user: publicUser(user)
                });
            }

            // AUTHENTICATED ROUTES
            if (path.startsWith('/api/')) {
                const user = requireAuth(req, res);
                if (!user) return;
            }

            const user = path.startsWith('/api/')
                ? getUser(req)
                : null;

            // ME
            if (path === '/api/me' && method === 'GET') {
                return send(res, 200, {
                    success: true,
                    user: publicUser(user)
                });
            }

            // LOGOUT
            if (path === '/api/logout' && method === 'POST') {
                const token = (req.headers.authorization || '').slice(7);
                sessions.delete(token);
                removeFromQueue(user.id);

                return send(res, 200, {
                    success: true,
                    message: 'Logged out'
                });
            }

            // LOBBY
            if (path === '/api/lobby' && method === 'GET') {
                return send(res, 200, {
                    success: true,
                    onlinePlayers: sessions.size,
                    waitingPlayers: queue.size,
                    rooms: [...rooms.values()].map(roomInfo)
                });
            }

            // ROOMS LIST
            if (path === '/api/rooms' && method === 'GET') {
                return send(res, 200, {
                    success: true,
                    rooms: [...rooms.values()].map(roomInfo)
                });
            }

            // CREATE ROOM
            if (path === '/api/rooms' && method === 'POST') {
                const body = await readBody(req);

                const name = typeof body.name === 'string'
                    ? body.name.trim()
                    : 'Private Room';

                const maxPlayers = Number(body.maxPlayers || 4);

                if (
                    name.length < 1 ||
                    name.length > 40 ||
                    !Number.isInteger(maxPlayers) ||
                    maxPlayers < 2 ||
                    maxPlayers > 10
                ) {
                    return send(res, 400, {
                        success: false,
                        error: 'INVALID_ROOM'
                    });
                }

                const room = {
                    id: createId(),
                    name,
                    owner: user.id,
                    players: [user.id],
                    maxPlayers,
                    status: 'waiting',
                    createdAt: Date.now()
                };

                rooms.set(room.id, room);

                return send(res, 201, {
                    success: true,
                    room: roomInfo(room)
                });
            }

            // ROOM ACTIONS
            const roomAction = path.match(
                /^\/api\/rooms\/([^/]+)\/(join|leave|start)$/
            );

            if (roomAction) {
                const [, roomId, action] = roomAction;
                const room = rooms.get(roomId);

                if (!room) {
                    return send(res, 404, {
                        success: false,
                        error: 'ROOM_NOT_FOUND'
                    });
                }

                if (action === 'join' && method === 'POST') {
                    if (room.status !== 'waiting') {
                        return send(res, 409, {
                            success: false,
                            error: 'ROOM_NOT_WAITING'
                        });
                    }

                    if (room.players.includes(user.id)) {
                        return send(res, 200, {
                            success: true,
                            room: roomInfo(room)
                        });
                    }

                    if (room.players.length >= room.maxPlayers) {
                        return send(res, 409, {
                            success: false,
                            error: 'ROOM_FULL'
                        });
                    }

                    room.players.push(user.id);

                    return send(res, 200, {
                        success: true,
                        room: roomInfo(room)
                    });
                }

                if (action === 'leave' && method === 'POST') {
                    room.players = room.players.filter(
                        id => id !== user.id
                    );

                    if (room.players.length === 0) {
                        rooms.delete(roomId);
                    } else if (room.owner === user.id) {
                        room.owner = room.players[0];
                    }

                    return send(res, 200, {
                        success: true
                    });
                }

                if (action === 'start' && method === 'POST') {
                    if (room.owner !== user.id) {
                        return send(res, 403, {
                            success: false,
                            error: 'NOT_ROOM_OWNER'
                        });
                    }

                    if (room.status !== 'waiting') {
                        return send(res, 409, {
                            success: false,
                            error: 'ROOM_ALREADY_STARTED'
                        });
                    }

                    room.status = 'active';

                    const match = createMatch(
                        room.players,
                        room.id
                    );

                    return send(res, 200, {
                        success: true,
                        match
                    });
                }
            }

            // MATCHMAKING JOIN
            if (
                path === '/api/matchmaking/join' &&
                method === 'POST'
            ) {
                if (queue.has(user.id)) {
                    return send(res, 200, {
                        success: true,
                        status: 'waiting'
                    });
                }

                queue.set(user.id, {
                    userId: user.id,
                    joinedAt: Date.now()
                });

                const players = [...queue.keys()];

                if (players.length >= 2) {
                    const matchedPlayers = players.slice(0, 2);

                    for (const id of matchedPlayers) {
                        queue.delete(id);
                    }

                    const match = createMatch(matchedPlayers);

                    return send(res, 200, {
                        success: true,
                        status: 'matched',
                        matchedPlayers,
                        match
                    });
                }

                return send(res, 200, {
                    success: true,
                    status: 'waiting'
                });
            }

            // MATCHMAKING LEAVE
            if (
                path === '/api/matchmaking/leave' &&
                method === 'POST'
            ) {
                removeFromQueue(user.id);

                return send(res, 200, {
                    success: true,
                    status: 'left'
                });
            }

            // MATCH DETAILS
            const matchRoute = path.match(
                /^\/api\/matches\/([^/]+)$/
            );

            if (matchRoute && method === 'GET') {
                const match = matches.get(matchRoute[1]);

                if (!match) {
                    return send(res, 404, {
                        success: false,
                        error: 'MATCH_NOT_FOUND'
                    });
                }

                if (!match.players.includes(user.id)) {
                    return send(res, 403, {
                        success: false,
                        error: 'NOT_MATCH_PLAYER'
                    });
                }

                return send(res, 200, {
                    success: true,
                    match
                });
            }

            // FINISH MATCH
            const finishRoute = path.match(
                /^\/api\/matches\/([^/]+)\/finish$/
            );

            if (finishRoute && method === 'POST') {
                const match = matches.get(finishRoute[1]);

                if (!match) {
                    return send(res, 404, {
                        success: false,
                        error: 'MATCH_NOT_FOUND'
                    });
                }

                if (!match.players.includes(user.id)) {
                    return send(res, 403, {
                        success: false,
                        error: 'NOT_MATCH_PLAYER'
                    });
                }

                if (match.status === 'finished') {
                    return send(res, 409, {
                        success: false,
                        error: 'MATCH_ALREADY_FINISHED'
                    });
                }

                match.status = 'finished';
                match.finishedAt = Date.now();

                return send(res, 200, {
                    success: true,
                    match
                });
            }

            return send(res, 404, {
                success: false,
                error: 'NOT_FOUND'
            });

        } catch (error) {
            if (!res.writableEnded && !res.destroyed) {
                const status = error.message === 'BODY_TOO_LARGE'
                    ? 413
                    : error.message === 'INVALID_JSON'
                        ? 400
                        : 500;

                send(res, status, {
                    success: false,
                    error: status === 500
                        ? 'INTERNAL_SERVER_ERROR'
                        : error.message
                });
            }
        }
    }

    const server = http.createServer(handler);

    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    server.keepAliveTimeout = 5000;

    return server;
}

if (require.main === module) {
    const server = createServer();

    const PORT = Number(process.env.PORT || 3000);

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`FF Private Backend running on port ${PORT}`);
    });

    function shutdown() {
        server.close(() => {
            process.exit(0);
        });
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

module.exports = { createServer };
