
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

function createServer() {
    const accounts = new Map();
    const sessions = new Map();
    const queue = new Map();
    const matches = new Map();

    function send(res, status, data) {
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        res.end(JSON.stringify(data));
    }

    async function readBody(req) {
        let raw = '';
        for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 8192) {
                throw new Error('BODY_TOO_LARGE');
            }
        }

        if (!raw) return {};

        try {
            return JSON.parse(raw);
        } catch {
            throw new Error('INVALID_JSON');
        }
    }

    function getUser(req) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ')
            ? header.slice(7)
            : '';

        return sessions.get(token) || null;
    }

    function createSession(username) {
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, username);
        return token;
    }

    function hashPassword(password, salt) {
        return crypto.scryptSync(password, salt, 64)
            .toString('hex');
    }

    function verifyPassword(password, account) {
        const actual = Buffer.from(
            hashPassword(password, account.salt),
            'hex'
        );

        const expected = Buffer.from(account.passwordHash, 'hex');

        return crypto.timingSafeEqual(actual, expected);
    }

    const app = http.createServer(async (req, res) => {
        const url = new URL(
            req.url,
            'http://localhost'
        );

        const path = url.pathname;
        const method = req.method;

        try {
            // SERVER STATUS
            if (method === 'GET' && path === '/health') {
                return send(res, 200, {
                    status: 'online',
                    version: '2.0.0',
                    node: process.version,
                    modules: [
                        'account',
                        'lobby',
                        'matchmaking'
                    ]
                });
            }

            // ACCOUNT REGISTER
            if (method === 'POST' && path === '/api/register') {
                const body = await readBody(req);

                const username = String(body.username || '')
                    .trim()
                    .toLowerCase();

                const password = body.password;

                if (!/^[a-z0-9_]{3,20}$/.test(username)) {
                    return send(res, 400, {
                        error: 'INVALID_USERNAME'
                    });
                }

                if (
                    typeof password !== 'string' ||
                    password.length < 8 ||
                    password.length > 128
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
                    passwordHash: hashPassword(password, salt),
                    createdAt: new Date().toISOString()
                });

                const token = createSession(username);

                return send(res, 201, {
                    message: 'ACCOUNT_CREATED',
                    token,
                    user: { username }
                });
            }

            // ACCOUNT LOGIN
            if (method === 'POST' && path === '/api/login') {
                const body = await readBody(req);

                const username = String(body.username || '')
                    .trim()
                    .toLowerCase();

                const account = accounts.get(username);

                if (
                    !account ||
                    typeof body.password !== 'string' ||
                    !verifyPassword(body.password, account)
                ) {
                    return send(res, 401, {
                        error: 'INVALID_CREDENTIALS'
                    });
                }

                const token = createSession(username);

                return send(res, 200, {
                    message: 'LOGIN_SUCCESS',
                    token,
                    user: { username }
                });
            }

            // AUTHENTICATED ROUTES
            const username = getUser(req);

            if (!username) {
                return send(res, 401, {
                    error: 'UNAUTHORIZED'
                });
            }

            // ACCOUNT PROFILE
            if (method === 'GET' && path === '/api/me') {
                const account = accounts.get(username);

                return send(res, 200, {
                    username,
                    createdAt: account.createdAt
                });
            }

            // LOGOUT
            if (method === 'POST' && path === '/api/logout') {
                const token = req.headers.authorization.slice(7);

                sessions.delete(token);
                queue.delete(username);

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

            // MATCHMAKING JOIN
            if (method === 'POST' && path === '/api/matchmaking/join') {
                const existingMatch = [...matches.values()]
                    .find(match => match.players.includes(username));

                if (existingMatch) {
                    return send(res, 200, {
                        status: 'matched',
                        match: existingMatch
                    });
                }

                if (queue.has(username)) {
                    return send(res, 200, {
                        status: 'waiting'
                    });
                }

                queue.set(username, Date.now());

                if (queue.size >= 2) {
                    const players = [...queue.keys()].slice(0, 2);

                    const match = {
                        id: crypto.randomUUID(),
                        players,
                        status: 'created',
                        createdAt: new Date().toISOString()
                    };

                    matches.set(match.id, match);

                    for (const player of players) {
                        queue.delete(player);
                    }

                    return send(res, 200, {
                        status: 'matched',
                        match
                    });
                }

                return send(res, 200, {
                    status: 'waiting',
                    message: 'WAITING_FOR_PLAYER'
                });
            }

            // MATCHMAKING LEAVE
            if (
                method === 'POST' &&
                path === '/api/matchmaking/leave'
            ) {
                queue.delete(username);

                return send(res, 200, {
                    message: 'QUEUE_LEFT'
                });
            }

            // MATCH STATUS
            if (
                method === 'GET' &&
                path === '/api/matchmaking/status'
            ) {
                const match = [...matches.values()]
                    .find(item => item.players.includes(username));

                if (match) {
                    return send(res, 200, {
                        status: 'matched',
                        match
                    });
                }

                if (queue.has(username)) {
                    return send(res, 200, {
                        status: 'waiting'
                    });
                }

                return send(res, 200, {
                    status: 'idle'
                });
            }

            return send(res, 404, {
                error: 'NOT_FOUND'
            });

        } catch (error) {
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

            console.error(error);

            return send(res, 500, {
                error: 'INTERNAL_SERVER_ERROR'
            });
        }
    });

    return app;
}

const server = createServer();

if (require.main === module) {
    const port = Number(process.env.PORT || 3000);

    server.listen(port, '0.0.0.0', () => {
        console.log(`FF Backend v2 listening on ${port}`);
    });
}

module.exports = { createServer };
