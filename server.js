const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Memory Game Server OK');
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();
const waitingPlayers = []; // { ws, searchStart }

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return rooms.has(code) ? generateCode() : code;
}

wss.on('connection', (ws) => {
  console.log('+Player');
  let playerRoom = null;
  let playerId = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case 'create_room': {
        const code = generateCode();
        rooms.set(code, {
          code, players: [ws], deck: null,
          gridSize: 4, emojiSet: 'food', totalPairs: 8,
          currentTurn: 1, scores: [0, 0], matchedPairs: 0,
          gameStarted: false
        });
        playerRoom = code;
        playerId = 0;
        ws.send(JSON.stringify({ type: 'room_created', code }));
        break;
      }

      case 'join_room': {
        const room = rooms.get(msg.code?.toUpperCase());
        if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Room not found' })); return; }
        if (room.players.length >= 2) { ws.send(JSON.stringify({ type: 'error', msg: 'Room full' })); return; }
        
        room.players.push(ws);
        playerRoom = msg.code.toUpperCase();
        playerId = 1;
        room.gameStarted = true;
        
        room.players[0].send(JSON.stringify({ type: 'opponent_joined' }));
        ws.send(JSON.stringify({ type: 'joined', code: playerRoom, playerId: 1 }));
        room.players[0].send(JSON.stringify({ type: 'start_game', playerId: 0, firstTurn: true }));
        room.players[1].send(JSON.stringify({ type: 'start_game', playerId: 1, firstTurn: false }));
        break;
      }

      case 'find_match': {
        // Remove if already in queue
        const existingIdx = waitingPlayers.findIndex(p => p.ws === ws);
        if (existingIdx !== -1) waitingPlayers.splice(existingIdx, 1);
        
        waitingPlayers.push({ ws, searchStart: Date.now() });
        ws.send(JSON.stringify({ type: 'searching' }));
        
        // Try to match
        if (waitingPlayers.length >= 2) {
          const p1 = waitingPlayers.shift();
          const p2 = waitingPlayers.shift();
          const code = generateCode();
          
          const room = {
            code, players: [p1.ws, p2.ws], deck: null,
            gridSize: 4, emojiSet: 'food', totalPairs: 8,
            currentTurn: 1, scores: [0, 0], matchedPairs: 0,
            gameStarted: true
          };
          rooms.set(code, room);
          
          p1.ws._room = code; p1.ws._playerId = 0;
          p2.ws._room = code; p2.ws._playerId = 1;
          
          p1.ws.send(JSON.stringify({ type: 'match_found_msg', playerId: 0 }));
          p2.ws.send(JSON.stringify({ type: 'match_found_msg', playerId: 1 }));
          
          setTimeout(() => {
            p1.ws.send(JSON.stringify({ type: 'start_game', playerId: 0, firstTurn: true, code }));
            p2.ws.send(JSON.stringify({ type: 'start_game', playerId: 1, firstTurn: false, code }));
          }, 500);
        }
        break;
      }

      case 'cancel_search': {
        const idx = waitingPlayers.findIndex(p => p.ws === ws);
        if (idx !== -1) waitingPlayers.splice(idx, 1);
        ws.send(JSON.stringify({ type: 'search_cancelled' }));
        break;
      }

      case 'send_deck': {
        const room = rooms.get(playerRoom);
        if (!room) return;
        room.deck = msg.deck;
        room.gridSize = msg.gridSize;
        room.emojiSet = msg.emojiSet;
        room.totalPairs = msg.totalPairs;
        room.players.forEach((p, i) => {
          if (i !== playerId && p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'receive_deck', deck: msg.deck, gridSize: msg.gridSize, emojiSet: msg.emojiSet, totalPairs: msg.totalPairs }));
          }
        });
        break;
      }

      case 'flip': {
        const room = rooms.get(playerRoom);
        if (!room) return;
        room.players.forEach((p, i) => {
          if (i !== playerId && p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'opponent_flip', index: msg.index }));
          }
        });
        break;
      }

      case 'match_found': {
        const room = rooms.get(playerRoom);
        if (!room) return;
        room.scores = msg.scores;
        room.matchedPairs = msg.matched;
        room.currentTurn = msg.currentTurn;
        room.players.forEach((p, i) => {
          if (i !== playerId && p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'match_result', success: true, index1: msg.index1, index2: msg.index2, scores: msg.scores, matched: msg.matched, currentTurn: msg.currentTurn }));
          }
        });
        break;
      }

      case 'no_match': {
        const room = rooms.get(playerRoom);
        if (!room) return;
        room.currentTurn = msg.currentTurn;
        room.players.forEach((p, i) => {
          if (i !== playerId && p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'match_result', success: false, index1: msg.index1, index2: msg.index2, currentTurn: msg.currentTurn }));
          }
        });
        break;
      }

      case 'game_over': {
        const room = rooms.get(playerRoom);
        if (!room) return;
        room.players.forEach((p, i) => {
          if (i !== playerId && p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'opponent_finished', scores: msg.scores }));
          }
        });
        break;
      }

      case 'rematch_accept': {
        const room = rooms.get(playerRoom);
        if (!room) return;
        room.scores = [0, 0];
        room.matchedPairs = 0;
        room.currentTurn = 1;
        room.deck = null;
        room.players.forEach((p, i) => {
          if (p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'start_game', playerId: i, firstTurn: i === 0, code: playerRoom }));
          }
        });
        break;
      }

      case 'request_rematch': {
        const room = rooms.get(playerRoom);
        if (!room) return;
        room.players.forEach((p, i) => {
          if (i !== playerId && p.readyState === WebSocket.OPEN) {
            p.send(JSON.stringify({ type: 'rematch_request' }));
          }
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    // Remove from waiting queue
    const qIdx = waitingPlayers.findIndex(p => p.ws === ws);
    if (qIdx !== -1) waitingPlayers.splice(qIdx, 1);
    
    // Notify room opponent
    if (playerRoom && rooms.has(playerRoom)) {
      const room = rooms.get(playerRoom);
      room.players.forEach((p, i) => {
        if (p !== ws && p.readyState === WebSocket.OPEN) {
          p.send(JSON.stringify({ type: 'opponent_left', winner: i }));
        }
      });
      // Clear room after delay
      setTimeout(() => { rooms.delete(playerRoom); }, 5000);
    }
  });
});

// Cleanup stale waiting players (every 30 seconds)
setInterval(() => {
  const now = Date.now();
  for (let i = waitingPlayers.length - 1; i >= 0; i--) {
    if (now - waitingPlayers[i].searchStart > 60000) {
      const ws = waitingPlayers[i].ws;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'search_timeout' }));
      }
      waitingPlayers.splice(i, 1);
    }
  }
}, 30000);

server.listen(PORT, () => console.log(`Server on port ${PORT}`));
