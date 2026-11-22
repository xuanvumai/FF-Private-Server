
# FF Private Backend V3

Standalone multiplayer backend simulator.

## Runtime

Node.js 24

## Modules

- Account registration
- Login authentication
- Player lobby
- Matchmaking
- Room creation
- Room joining and leaving
- Match lifecycle
- Match result

## Install

npm install

## Start

npm start

## Test

npm test

## API

### Account

POST /api/register
POST /api/login
GET /api/me
POST /api/logout

### Lobby

GET /api/lobby

### Rooms

POST /api/rooms
GET /api/rooms
POST /api/rooms/:id/join
POST /api/rooms/:id/leave
POST /api/rooms/:id/start

### Matchmaking

POST /api/matchmaking/join
POST /api/matchmaking/leave

### Matches

GET /api/matches/:id
POST /api/matches/:id/finish

### Health

GET /health

## GitHub Actions

.github/workflows/test.yml
