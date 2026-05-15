const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Memory Game WebSocket Server');
});

const wss = new WebSocket.Server({ server });

// Game rooms storage
const rooms = new Map();
const waitingPlayers = new Set();

// Generate random room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
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
    try {
      msg = JSON.parse(message);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      case 'create_room':
        const roomCode = generateRoomCode();
        const room = {
          code: roomCode,
          players: [ws],
          deck: null,
          gameStarted: false
        };
        rooms.set(roomCode, room);
        playerRoom = roomCode;
        playerIndex = 0;
        ws.send(JSON.stringify({ type: 'room_created', roomCode }));
        console.log(`Room created: ${roomCode}`);
        break;

      case 'join_room':
        const roomToJoin = rooms.get(msg.roomCode);
        if (!roomToJoin) {
          ws.send(JSON.stringify({ type: 'error', msg: 'room_not_found' }));
          return;
        }
        if (roomToJoin.players.length >= 2) {
          ws.send(JSON.stringify({ type: 'error', msg: 'room_full' }));
          return;
        }
        if (roomToJoin.gameStarted) {
          ws.send(JSON.stringify({ type: 'error', msg: 'game_started' }));
          return;
        }
        roomToJoin.players.push(ws);
        playerRoom = msg.roomCode;
        playerIndex = 1;
        ws.send(JSON.stringify({ type: 'room_joined', roomCode: msg.roomCode }));
        
        // Start game
        roomToJoin.players.forEach((p, idx) => {
          p.send(JSON.stringify({ type: 'match_found', roomCode: msg.roomCode }));
          p.send(JSON.stringify({ type: 'game_start', yourIndex: idx }));
        });
        roomToJoin.gameStarted = true;
        console.log(`Game started in room ${msg.roomCode}`);
        break;

      case 'find_match':
        if (waitingPlayers.size > 0) {
          const opponent = Array.from(waitingPlayers)[0];
          waitingPlayers.delete(opponent);
          const newRoomCode = generateRoomCode();
          const newRoom = {
            code: newRoomCode,
            players: [opponent, ws],
            deck: null,
            gameStarted: false
          };
          rooms.set(newRoomCode, newRoom);
          
          ws.send(JSON.stringify({ type: 'match_found', roomCode: newRoomCode }));
          opponent.send(JSON.stringify({ type: 'match_found', roomCode: newRoomCode }));
          
          newRoom.players.forEach((p, idx) => {
            p.send(JSON.stringify({ type: 'game_start', yourIndex: idx }));
          });
          newRoom.gameStarted = true;
          playerRoom = newRoomCode;
          playerIndex = 1;
          
          // Fix opponent's state
          newRoom.players[0].playerRoom = newRoomCode;
          newRoom.players[0].playerIndex = 0;
        } else {
          waitingPlayers.add(ws);
          ws.send(JSON.stringify({ type: 'searching' }));
          console.log('Player waiting for match');
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
              p.send(JSON.stringify({
                type: 'game_state',
                deck: msg.deck,
                gridSize: msg.gridSize,
                emojiSet: msg.emojiSet
              }));
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
      room.players.forEach((p, idx) => {
        if (p !== ws && p.readyState === WebSocket.OPEN) {
          p.send(JSON.stringify({ type: 'opponent_left' }));
        }
      });
      rooms.delete(playerRoom);
      console.log(`Room ${playerRoom} deleted`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    waitingPlayers.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});