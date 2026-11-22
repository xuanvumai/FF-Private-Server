
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

test('FF backend integration tests', async (t) => {
    const server = createServer();

    await new Promise(resolve => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;

    const tokens = {};

    async function request(path, method = 'GET', body, token) {
        const headers = {};

        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(base + path, {
            method,
            headers,
            body: body === undefined
                ? undefined
                : JSON.stringify(body)
        });

        return {
            status: response.status,
            data: await response.json()
        };
    }

    t.after(async () => {
        await new Promise(resolve => {
            server.close(resolve);
        });
    });

    await t.test('Health check', async () => {
        const result = await request('/health');

        assert.equal(result.status, 200);
        assert.equal(result.data.status, 'online');
        assert.ok(result.data.node.startsWith('v24'));
    });

    await t.test('Register first player', async () => {
        const result = await request('/api/register', 'POST', {
            username: 'player_one',
            password: 'Password123!'
        });

        assert.equal(result.status, 201);
        assert.ok(result.data.token);

        tokens.one = result.data.token;
    });

    await t.test('Register second player', async () => {
        const result = await request('/api/register', 'POST', {
            username: 'player_two',
            password: 'Password123!'
        });

        assert.equal(result.status, 201);
        tokens.two = result.data.token;
    });

    await t.test('Reject duplicate account', async () => {
        const result = await request('/api/register', 'POST', {
            username: 'player_one',
            password: 'Password123!'
        });

        assert.equal(result.status, 409);
    });

    await t.test('Login account', async () => {
        const result = await request('/api/login', 'POST', {
            username: 'player_one',
            password: 'Password123!'
        });

        assert.equal(result.status, 200);
        assert.ok(result.data.token);
    });

    await t.test('Get player profile', async () => {
        const result = await request(
            '/api/me',
            'GET',
            undefined,
            tokens.one
        );

        assert.equal(result.status, 200);
        assert.equal(result.data.username, 'player_one');
    });

    await t.test('Lobby has two players', async () => {
        const result = await request(
            '/api/lobby',
            'GET',
            undefined,
            tokens.one
        );

        assert.equal(result.status, 200);
        assert.equal(result.data.onlineCount, 2);
    });

    await t.test('First player waits in queue', async () => {
        const result = await request(
            '/api/matchmaking/join',
            'POST',
            {},
            tokens.one
        );

        assert.equal(result.status, 200);
        assert.equal(result.data.status, 'waiting');
    });

    await t.test('Second player creates match', async () => {
        const result = await request(
            '/api/matchmaking/join',
            'POST',
            {},
            tokens.two
        );

        assert.equal(result.status, 200);
        assert.equal(result.data.status, 'matched');
        assert.equal(result.data.match.players.length, 2);
    });

    await t.test('First player receives match status', async () => {
        const result = await request(
            '/api/matchmaking/status',
            'GET',
            undefined,
            tokens.one
        );

        assert.equal(result.status, 200);
        assert.equal(result.data.status, 'matched');
    });

    await t.test('Reject unauthenticated request', async () => {
        const result = await request('/api/me');

        assert.equal(result.status, 401);
    });
});
