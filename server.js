const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Memory Game WebSocket Server');
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
const waitingPlayers = new Set();

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

wss.on('connection', (ws) => {
  console.log('New client connected');
  let playerRoom = null;
  let playerIndex = -1;

  ws.on('message', (message) => {
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }

    switch (msg.type) {
      case 'create_room':
        const roomCode = generateRoomCode();
        const room = { code: roomCode, players: [ws], gameStarted: false };
        rooms.set(roomCode, room);
        playerRoom = roomCode;
        playerIndex = 0;
        ws.send(JSON.stringify({ type: 'room_created', roomCode }));
        console.log(`Room created: ${roomCode}`);
        break;

      case 'join_room':
        const roomToJoin = rooms.get(msg.roomCode);
        if (!roomToJoin) { ws.send(JSON.stringify({ type: 'error', msg: 'room_not_found' })); return; }
        if (roomToJoin.players.length >= 2) { ws.send(JSON.stringify({ type: 'error', msg: 'room_full' })); return; }
        roomToJoin.players.push(ws);
        playerRoom = msg.roomCode;
        playerIndex = 1;
        ws.send(JSON.stringify({ type: 'room_joined', roomCode: msg.roomCode }));
        roomToJoin.players.forEach((p, idx) => {
          p.send(JSON.stringify({ type: 'match_found', roomCode: msg.roomCode }));
          p.send(JSON.stringify({ type: 'game_start', yourIndex: idx }));
        });
        roomToJoin.gameStarted = true;
        break;

      case 'find_match':
        if (waitingPlayers.size > 0) {
          const opponent = Array.from(waitingPlayers)[0];
          waitingPlayers.delete(opponent);
          const newRoomCode = generateRoomCode();
          const newRoom = { code: newRoomCode, players: [opponent, ws], gameStarted: false };
          rooms.set(newRoomCode, newRoom);
          newRoom.players.forEach((p, idx) => {
            p.send(JSON.stringify({ type: 'match_found', roomCode: newRoomCode }));
            p.send(JSON.stringify({ type: 'game_start', yourIndex: idx }));
          });
          newRoom.gameStarted = true;
          playerRoom = newRoomCode;
          playerIndex = 1;
        } else {
          waitingPlayers.add(ws);
          ws.send(JSON.stringify({ type: 'searching' }));
        }
        break;

      case 'cancel_search':
        waitingPlayers.delete(ws);
        ws.send(JSON.stringify({ type: 'search_cancelled' }));
        break;

      case 'game_state':
        if (playerRoom && rooms.has(playerRoom)) {
          const room = rooms.get(playerRoom);
          room.players.forEach((p, idx) => {
            if (idx !== playerIndex) {
              p.send(JSON.stringify({ type: 'game_state', deck: msg.deck, gridSize: msg.gridSize, emojiSet: msg.emojiSet }));
            }
          });
        }
        break;

      case 'flip_card':
        if (playerRoom && rooms.has(playerRoom)) {
          const room = rooms.get(playerRoom);
          room.players.forEach((p, idx) => {
            if (idx !== playerIndex) {
              p.send(JSON.stringify({
                type: 'flip_card',
                cardIndex: msg.cardIndex,
                phase: msg.phase,
                secondIndex: msg.secondIndex,
                scores: msg.scores,
                curPlayer: msg.curPlayer
              }));
            }
          });
        }
        break;

      case 'new_game':
        if (playerRoom && rooms.has(playerRoom)) {
          const room = rooms.get(playerRoom);
          room.players.forEach((p, idx) => {
            p.send(JSON.stringify({ type: 'new_game' }));
          });
        }
        break;
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    waitingPlayers.delete(ws);
    if (playerRoom && rooms.has(playerRoom)) {
      const room = rooms.get(playerRoom);
      room.players.forEach((p) => {
        if (p !== ws && p.readyState === WebSocket.OPEN) {
          p.send(JSON.stringify({ type: 'opponent_left' }));
        }
      });
      rooms.delete(playerRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
