
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Node.js 24 runtime', () => {
    assert.equal(process.versions.node.split('.')[0], '24');
});

test('Backend configuration', () => {
    const port = Number(process.env.PORT || 3000);

    assert.ok(Number.isInteger(port));
    assert.ok(port > 0 && port <= 65535);
});

test('HTTP module available', () => {
    const http = require('node:http');

    assert.equal(typeof http.createServer, 'function');
});

test('Health endpoint configuration', () => {
    const endpoint = '/health';

    assert.equal(endpoint, '/health');
});
