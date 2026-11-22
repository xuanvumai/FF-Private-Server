
'use strict';

const http = require('node:http');

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
            status: 'online',
            name: 'FF Private Backend Test',
            node: process.version,
            timestamp: new Date().toISOString()
        }));
        return;
    }

    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200);
        res.end(JSON.stringify({
            message: 'FF Backend is running',
            endpoints: ['/health']
        }));
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({
        error: 'Not Found'
    }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend listening on port ${PORT}`);
});

module.exports = server;
