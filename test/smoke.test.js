
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

test('FF Backend V3 integration', async (t) => {
    const server = createServer();

    await new Promise(resolve => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const base = `http://127.0.0.1:${server.address().port}`;
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
        await new Promise(resolve => server.close(resolve));
    });

    await t.test('Health check', async () => {
        const result = await request('/health');

        assert.equal(result.status, 200);
        assert.equal(result.data.version, '3.0.0');
    });

    await t.test('Register players', async () => {
        for (const username of ['player_one', 'player_two']) {
            const result = await request('/api/register', 'POST', {
                username,
                password: 'Password123!'
            });

            assert.equal(result.status, 201);
            assert.ok(result.data.token);

            tokens[username] = result.data.token;
        }
    });

    await t.test('Reject duplicate account', async () => {
        const result = await request('/api/register', 'POST', {
            username: 'player_one',
            password: 'Password123!'
        });

        assert.equal(result.status, 409);
    });

    await t.test('Authenticate player', async () => {
        const result = await request('/api/me', 'GET', undefined,
            tokens.player_one);

        assert.equal(result.status, 200);
        assert.equal(result.data.username, 'player_one');
    });

    let roomId;
    let matchId;

    await t.test('Create room', async () => {
        const result = await request('/api/rooms', 'POST', {
            name: 'Test Battle Room',
            maxPlayers: 2
        }, tokens.player_one);

        assert.equal(result.status, 201);
        assert.equal(result.data.room.players.length, 1);

        roomId = result.data.room.id;
    });

    await t.test('List rooms', async () => {
        const result = await request('/api/rooms', 'GET',
            undefined, tokens.player_one);

        assert.equal(result.status, 200);
        assert.equal(result.data.rooms.length, 1);
    });

    await t.test('Second player joins room', async () => {
        const result = await request(
            `/api/rooms/${roomId}/join`,
            'POST',
            {},
            tokens.player_two
        );

        assert.equal(result.status, 200);
        assert.equal(result.data.room.players.length, 2);
    });

    await t.test('Reject non-host starting match', async () => {
        const result = await request(
            `/api/rooms/${roomId}/start`,
            'POST',
            {},
            tokens.player_two
        );

        assert.equal(result.status, 403);
    });

    await t.test('Host starts match', async () => {
        const result = await request(
            `/api/rooms/${roomId}/start`,
            'POST',
            {},
            tokens.player_one
        );

        assert.equal(result.status, 200);
        assert.equal(result.data.match.status, 'started');

        matchId = result.data.match.id;
    });

    await t.test('Player reads match', async () => {
        const result = await request(
            `/api/matches/${matchId}`,
            'GET',
            undefined,
            tokens.player_two
        );

        assert.equal(result.status, 200);
        assert.equal(result.data.match.players.length, 2);
    });

    await t.test('Finish match', async () => {
        const result = await request(
            `/api/matches/${matchId}/finish`,
            'POST',
            { winner: 'player_one' },
            tokens.player_one
        );

        assert.equal(result.status, 200);
        assert.equal(result.data.match.status, 'completed');
        assert.equal(result.data.match.winner, 'player_one');
    });

    await t.test('Reject invalid winner', async () => {
        const result = await request(
            `/api/matches/${matchId}/finish`,
            'POST',
            { winner: 'unknown_player' },
            tokens.player_two
        );

        assert.equal(result.status, 409);
    });

    await t.test('Matchmaking works', async () => {
        const first = await request(
            '/api/matchmaking/join',
            'POST',
            {},
            tokens.player_one
        );

        assert.equal(first.data.status, 'waiting');

        const second = await request(
            '/api/matchmaking/join',
            'POST',
            {},
            tokens.player_two
        );

        assert.equal(second.data.status, 'matched');
        assert.equal(second.data.match.players.length, 2);
    });

    await t.test('Reject unauthenticated access', async () => {
        const result = await request('/api/rooms');

        assert.equal(result.status, 401);
    });
});
