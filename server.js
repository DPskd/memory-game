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

const EMOJI_SETS = {
  food: ['🍕','🍔','🌮','🍣','🍩','🎂','🍦','🥑','🍋','🍇','🍓','🥐','🍜','🌯','🧇','🫐','🥪','🍱','🧆','🥨','🍡','🍤','🥧','🧃','🥟','🍙','🍛','🥯','🌽','🧀','🍫','🍰'],
  animals: ['🐱','🐶','🦊','🐼','🐨','🦁','🐯','🦋','🐧','🐬','🦒','🦓','🦄','🦕','🐙','🦀','🦜','🦩','🐻','🐮','🐸','🦔','🐺','🦦','🦉','🦥','🦘','🐝','🐡','🦈','🐛','🐌'],
  nature: ['🌺','🌸','🌻','🌹','🌿','🍀','🌴','🌵','🍁','🍄','🌊','⛰️','🌋','🌈','☄️','❄️','🌙','⭐','🌟','💫','🔥','💧','🌪️','🌤️','⚡','🌕','🪐','🌑','🌞','☁️','🌝','🍃'],
  symbols: ['⚡','💎','🔮','💡','🎯','🎲','🎮','🎪','🎭','🎨','🎬','🎤','🏆','🔑','💌','📌','🧩','🪄','🔭','🧪','⚗️','🎸','🎺','🥁','🎷','🎻','🪘','🃏','🎰','🧲','🔩','⚙️']
};

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createGameState(deck, gridSize, emojiSet) {
  return {
    deck: deck.map((emoji, id) => ({
      id,
      emoji,
      flipped: false,
      matched: false,
      gone: false,
      owner: 0
    })),
    gridSize,
    emojiSet,
    totalPairs: deck.length / 2,
    curPlayer: 1,
    scores: [0, 0],
    streaks: [0, 0],
    flippedIndices: [],
    locked: false,
    matchedCount: 0,
    moves: 0,
    started: false
  };
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function sendToAll(room, msg) {
  room.players.forEach(p => {
    if (p.readyState === WebSocket.OPEN) p.send(JSON.stringify(msg));
  });
}

function broadcast(room, msg, excludeWs) {
  room.players.forEach(p => {
    if (p !== excludeWs && p.readyState === WebSocket.OPEN) p.send(JSON.stringify(msg));
  });
}

function buildDeck(emojiSet, totalPairs) {
  const set = EMOJI_SETS[emojiSet] || EMOJI_SETS.food;
  const pool = shuffle([...set]).slice(0, totalPairs);
  return shuffle([...pool, ...pool]);
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  let playerRoom = null;
  let playerIndex = -1;

  ws.on('message', (message) => {
    let msg;
    try { msg = JSON.parse(message); } catch (e) { return; }

    switch (msg.type) {
      case 'create_room': {
        const roomCode = generateRoomCode();
        const room = { code: roomCode, players: [ws], gameState: null };
        rooms.set(roomCode, room);
        playerRoom = roomCode;
        playerIndex = 0;
        ws.send(JSON.stringify({ type: 'room_created', roomCode }));
        console.log(`Room created: ${roomCode}`);
        break;
      }

      case 'join_room': {
        const room = rooms.get(msg.roomCode);
        if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'room_not_found' })); return; }
        if (room.players.length >= 2) { ws.send(JSON.stringify({ type: 'error', msg: 'room_full' })); return; }
        room.players.push(ws);
        playerRoom = msg.roomCode;
        playerIndex = 1;
        ws.send(JSON.stringify({ type: 'room_joined', roomCode: msg.roomCode }));

        const gridSize = msg.gridSize || 4;
        const emojiSet = msg.emojiSet || 'food';
        const totalPairs = (gridSize * gridSize) / 2;
        const deck = buildDeck(emojiSet, totalPairs);
        const gs = createGameState(deck, gridSize, emojiSet);
        room.gameState = gs;
        sendToAll(room, { type: 'game_start' });
        room.players[0].send(JSON.stringify({ type: 'full_state', state: gs, yourIndex: 0 }));
        room.players[1].send(JSON.stringify({ type: 'full_state', state: gs, yourIndex: 1 }));
        console.log(`Game started in room ${msg.roomCode}`);
        break;
      }

      case 'find_match': {
        if (waitingPlayers.size > 0) {
          const opponent = Array.from(waitingPlayers)[0];
          waitingPlayers.delete(opponent);
          const roomCode = generateRoomCode();
          const room = { code: roomCode, players: [opponent, ws], gameState: null };
          rooms.set(roomCode, room);
          
          const gridSize = msg.gridSize || 4;
          const emojiSet = msg.emojiSet || 'food';
          const totalPairs = (gridSize * gridSize) / 2;
          const deck = buildDeck(emojiSet, totalPairs);
          const gs = createGameState(deck, gridSize, emojiSet);
          room.gameState = gs;
          
          sendToAll(room, { type: 'game_start' });
          opponent.send(JSON.stringify({ type: 'full_state', state: gs, yourIndex: 0 }));
          ws.send(JSON.stringify({ type: 'full_state', state: gs, yourIndex: 1 }));
          playerRoom = roomCode;
          playerIndex = 1;
          console.log(`Match found, room: ${roomCode}`);
        } else {
          waitingPlayers.add(ws);
          ws.send(JSON.stringify({ type: 'searching' }));
        }
        break;
      }

      case 'cancel_search':
        waitingPlayers.delete(ws);
        ws.send(JSON.stringify({ type: 'search_cancelled' }));
        break;

      case 'flip_card': {
        if (!playerRoom || !rooms.has(playerRoom)) return;
        const room = rooms.get(playerRoom);
        const gs = room.gameState;
        if (!gs || gs.locked) return;

        const currentPlayerIdx = gs.curPlayer === 1 ? 0 : 1;
        if (currentPlayerIdx !== playerIndex) return;

        const cardIndex = msg.cardIndex;
        const card = gs.deck[cardIndex];
        if (!card || card.flipped || card.matched || card.gone) return;
        if (gs.flippedIndices.length >= 2) return;

        // Flip first card
        card.flipped = true;
        gs.flippedIndices.push(cardIndex);
        broadcast(room, { type: 'card_flipped', cardIndex }, ws);

        // If two cards flipped, check match
        if (gs.flippedIndices.length === 2) {
          gs.locked = true;
          const [i1, i2] = gs.flippedIndices;
          const c1 = gs.deck[i1];
          const c2 = gs.deck[i2];
          gs.moves++;

          setTimeout(() => {
            if (c1.emoji === c2.emoji) {
              // MATCH!
              c1.matched = true;
              c2.matched = true;
              c1.owner = gs.curPlayer;
              c2.owner = gs.curPlayer;
              gs.matchedCount++;
              const pi = gs.curPlayer - 1;
              gs.scores[pi]++;
              gs.streaks[pi]++;
              gs.streaks[1 - pi] = 0;

              sendToAll(room, {
                type: 'cards_matched',
                i1, i2,
                owner: gs.curPlayer,
                scores: gs.scores,
                curPlayer: gs.curPlayer,
                matchedCount: gs.matchedCount
              });

              setTimeout(() => {
                c1.gone = true;
                c2.gone = true;
                sendToAll(room, { type: 'cards_gone', indices: [i1, i2] });
                
                if (gs.matchedCount === gs.totalPairs) {
                  sendToAll(room, { type: 'game_over', scores: gs.scores, moves: gs.moves });
                }
                
                gs.flippedIndices = [];
                gs.locked = false;
              }, 400);

            } else {
              // MISMATCH
              const pi = gs.curPlayer - 1;
              gs.streaks[pi] = 0;

              sendToAll(room, { type: 'cards_mismatch', i1, i2 });

              setTimeout(() => {
                c1.flipped = false;
                c2.flipped = false;
                gs.flippedIndices = [];
                gs.locked = false;
                gs.curPlayer = gs.curPlayer === 1 ? 2 : 1;

                sendToAll(room, {
                  type: 'turn_update',
                  curPlayer: gs.curPlayer,
                  scores: gs.scores,
                  streaks: gs.streaks
                });
              }, 600);
            }
          }, 500);
        }
        break;
      }

      case 'new_game': {
        if (!playerRoom || !rooms.has(playerRoom)) return;
        const room = rooms.get(playerRoom);
        const gs = room.gameState;
        const gridSize = gs.gridSize;
        const emojiSet = gs.emojiSet;
        const totalPairs = (gridSize * gridSize) / 2;
        const deck = buildDeck(emojiSet, totalPairs);
        room.gameState = createGameState(deck, gridSize, emojiSet);
        sendToAll(room, { type: 'full_state', state: room.gameState });
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    waitingPlayers.delete(ws);
    if (playerRoom && rooms.has(playerRoom)) {
      const room = rooms.get(playerRoom);
      broadcast(room, { type: 'opponent_left' }, ws);
      if (room.players.every(p => p.readyState !== WebSocket.OPEN)) {
        rooms.delete(playerRoom);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    waitingPlayers.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
