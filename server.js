const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Memory Game Server OK');
});

const wss = new WebSocket.Server({ server });

// Store: roomCode -> { players: [ws1, ws2], gameState: {...} }
const rooms = new Map();
// Queue for matchmaking
const waitingPlayers = [];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Check uniqueness
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

wss.on('connection', (ws) => {
  console.log('New player connected');
  let playerRoom = null;
  let playerId = -1; // 0 or 1
  let playerWs = ws;

  ws.on('message', (message) => {
    let msg;
    try { msg = JSON.parse(message); } 
    catch (e) { ws.send(JSON.stringify({ type: 'error', msg: 'Bad JSON' })); return; }

    switch (msg.type) {
      
      case 'create_room':
        const code = generateRoomCode();
        rooms.set(code, {
          code: code,
          players: [ws],
          deck: null,
          gridSize: 4,
          emojiSet: 'food',
          currentTurn: 1,
          scores: [0, 0],
          matchedPairs: 0,
          totalPairs: 8,
          gameStarted: false
        });
        playerRoom = code;
        playerId = 0;
        ws.send(JSON.stringify({ type: 'room_created', code }));
        console.log(`Room created: ${code}`);
        break;

      case 'join_room':
        const joinCode = msg.code?.toUpperCase();
        const room = rooms.get(joinCode);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Комната не найдена' }));
          return;
        }
        if (room.players.length >= 2) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Комната заполнена' }));
          return;
        }
        room.players.push(ws);
        playerRoom = joinCode;
        playerId = 1;
        
        // Notify both players
        room.players[0].send(JSON.stringify({ type: 'opponent_joined' }));
        ws.send(JSON.stringify({ type: 'joined', code: joinCode, playerId: 1 }));
        
        // Start the game
        room.gameStarted = true;
        room.players[0].send(JSON.stringify({ type: 'start_game', playerId: 0, firstTurn: true }));
        room.players[1].send(JSON.stringify({ type: 'start_game', playerId: 1, firstTurn: false }));
        console.log(`Game started in room ${joinCode}`);
        break;

      case 'find_match':
        // Add to queue
        waitingPlayers.push({ ws, room: null });
        ws.send(JSON.stringify({ type: 'searching' }));
        
        // If we have 2 players, match them
        if (waitingPlayers.length >= 2) {
          const p1 = waitingPlayers.shift();
          const p2 = waitingPlayers.shift();
          const matchCode = generateRoomCode();
          
          const matchRoom = {
            code: matchCode,
            players: [p1.ws, p2.ws],
            deck: null,
            gridSize: 4,
            emojiSet: 'food',
            currentTurn: 1,
            scores: [0, 0],
            matchedPairs: 0,
            totalPairs: 8,
            gameStarted: true
          };
          rooms.set(matchCode, matchRoom);
          
          p1.ws.playerRoom = matchCode;
          p1.ws.playerId = 0;
          p2.ws.playerRoom = matchCode;
          p2.ws.playerId = 1;
          
          p1.ws.send(JSON.stringify({ type: 'start_game', playerId: 0, firstTurn: true }));
          p2.ws.send(JSON.stringify({ type: 'start_game', playerId: 1, firstTurn: false }));
          console.log(`Match found: ${matchCode}`);
        }
        break;

      case 'cancel_search':
        const idx = waitingPlayers.findIndex(p => p.ws === ws);
        if (idx !== -1) waitingPlayers.splice(idx, 1);
        ws.send(JSON.stringify({ type: 'search_cancelled' }));
        break;

      case 'send_deck':
        if (playerRoom && rooms.has(playerRoom)) {
          const r = rooms.get(playerRoom);
          r.deck = msg.deck;
          r.gridSize = msg.gridSize;
          r.emojiSet = msg.emojiSet;
          r.totalPairs = msg.totalPairs;
          // Send to other player
          r.players.forEach((p, i) => {
            if (i !== playerId) {
              p.send(JSON.stringify({ 
                type: 'receive_deck', 
                deck: msg.deck,
                gridSize: msg.gridSize,
                emojiSet: msg.emojiSet,
                totalPairs: msg.totalPairs
              }));
            }
          });
        }
        break;

      case 'flip':
        if (playerRoom && rooms.has(playerRoom)) {
          const r = rooms.get(playerRoom);
          r.players.forEach((p, i) => {
            if (i !== playerId) {
              p.send(JSON.stringify({ type: 'opponent_flip', index: msg.index }));
            }
          });
        }
        break;

      case 'match_found':
        if (playerRoom && rooms.has(playerRoom)) {
          const r = rooms.get(playerRoom);
          r.scores = msg.scores;
          r.matchedPairs = msg.matched;
          r.currentTurn = msg.currentTurn;
          r.players.forEach((p, i) => {
            if (i !== playerId) {
              p.send(JSON.stringify({ 
                type: 'match_result',
                success: true,
                index1: msg.index1,
                index2: msg.index2,
                scores: msg.scores,
                matched: msg.matched,
                currentTurn: msg.currentTurn
              }));
            }
          });
        }
        break;

      case 'no_match':
        if (playerRoom && rooms.has(playerRoom)) {
          const r = rooms.get(playerRoom);
          r.currentTurn = msg.currentTurn;
          r.players.forEach((p, i) => {
            if (i !== playerId) {
              p.send(JSON.stringify({ 
                type: 'match_result',
                success: false,
                index1: msg.index1,
                index2: msg.index2,
                currentTurn: msg.currentTurn
              }));
            }
          });
        }
        break;

      case 'game_over':
        if (playerRoom && rooms.has(playerRoom)) {
          const r = rooms.get(playerRoom);
          r.players.forEach((p, i) => {
            if (i !== playerId) {
              p.send(JSON.stringify({ 
                type: 'opponent_finished',
                scores: msg.scores
              }));
            }
          });
        }
        break;

      case 'rematch':
        if (playerRoom && rooms.has(playerRoom)) {
          const r = rooms.get(playerRoom);
          r.players.forEach((p, i) => {
            if (i !== playerId) {
              p.send(JSON.stringify({ type: 'rematch_request' }));
            }
          });
        }
        break;

      case 'rematch_accept':
        if (playerRoom && rooms.has(playerRoom)) {
          const r = rooms.get(playerRoom);
          r.scores = [0, 0];
          r.matchedPairs = 0;
          r.currentTurn = 1;
          r.deck = null;
          
          r.players[0].send(JSON.stringify({ type: 'start_game', playerId: 0, firstTurn: true }));
          r.players[1].send(JSON.stringify({ type: 'start_game', playerId: 1, firstTurn: false }));
        }
        break;
    }
  });

  ws.on('close', () => {
    console.log('Player disconnected');
    
    // Remove from waiting queue
    const qIdx = waitingPlayers.findIndex(p => p.ws === ws);
    if (qIdx !== -1) waitingPlayers.splice(qIdx, 1);
    
    // Notify opponent and clean room
    if (playerRoom && rooms.has(playerRoom)) {
      const room = rooms.get(playerRoom);
      room.players.forEach((p, i) => {
        if (p !== ws && p.readyState === WebSocket.OPEN) {
          p.send(JSON.stringify({ type: 'opponent_left' }));
        }
      });
      rooms.delete(playerRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
