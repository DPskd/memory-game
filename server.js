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

const EMOJIS = [
  '🍕','🍔','🌮','🍣','🍩','🎂','🍦','🥑',
  '🍋','🍇','🍓','🥐','🍜','🌯','🧇','🫐',
  '🐱','🐶','🦊','🐼','🐨','🦁','🐯','🦋',
  '🌺','🌸','🌻','🌹','🌿','🍀','🌴','🌵'
];

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  let code = '';

  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return code;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
}

function createDeck(gridSize) {
  const totalPairs = (gridSize * gridSize) / 2;

  const selected = shuffle([...EMOJIS]).slice(0, totalPairs);

  const deck = shuffle(
    [...selected, ...selected].map((emoji, index) => ({
      id: index,
      emoji,
      flipped: false,
      matched: false
    }))
  );

  return deck;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  room.players.forEach((player) => {
    send(player, data);
  });
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  let playerRoom = null;
  let playerIndex = -1;

  ws.on('message', (message) => {
    let msg;

    try {
      msg = JSON.parse(message);
    } catch (e) {
      return;
    }

    switch (msg.type) {

      // ========================
      // CREATE ROOM
      // ========================

      case 'create_room': {

        const roomCode = generateRoomCode();

        const room = {
          code: roomCode,
          players: [ws],

          gridSize: 4,
          totalPairs: 8,

          deck: [],
          flipped: [],

          curPlayer: 1,
          scores: [0, 0],
          streaks: [0, 0],

          matchedCount: 0,
          moves: 0,
          locked: false
        };

        rooms.set(roomCode, room);

        playerRoom = roomCode;
        playerIndex = 0;

        send(ws, {
          type: 'room_created',
          roomCode
        });

        console.log('Room created:', roomCode);

        break;
      }

      // ========================
      // JOIN ROOM
      // ========================

      case 'join_room': {

        const room = rooms.get(msg.roomCode);

        if (!room) {
          send(ws, {
            type: 'error',
            msg: 'room_not_found'
          });

          return;
        }

        if (room.players.length >= 2) {
          send(ws, {
            type: 'error',
            msg: 'room_full'
          });

          return;
        }

        room.players.push(ws);

        playerRoom = msg.roomCode;
        playerIndex = 1;

        room.gridSize = msg.gridSize || 4;
        room.totalPairs = (room.gridSize * room.gridSize) / 2;

        room.deck = createDeck(room.gridSize);

        broadcast(room, {
          type: 'match_found',
          roomCode: room.code
        });

        room.players.forEach((player, idx) => {

          send(player, {
            type: 'game_start',
            yourIndex: idx
          });

          send(player, {
            type: 'full_state',

            yourIndex: idx,

            state: {
              gridSize: room.gridSize,
              totalPairs: room.totalPairs,
              deck: room.deck,

              curPlayer: room.curPlayer,
              scores: room.scores,
              streaks: room.streaks,

              matchedCount: room.matchedCount,
              moves: room.moves,
              locked: room.locked
            }
          });

        });

        console.log('Game started:', room.code);

        break;
      }

      // ========================
      // FIND MATCH
      // ========================

      case 'find_match': {

        if (waitingPlayers.size > 0) {

          const opponent = Array.from(waitingPlayers)[0];

          waitingPlayers.delete(opponent);

          const roomCode = generateRoomCode();

          const room = {
            code: roomCode,
            players: [opponent, ws],

            gridSize: 4,
            totalPairs: 8,

            deck: createDeck(4),
            flipped: [],

            curPlayer: 1,
            scores: [0, 0],
            streaks: [0, 0],

            matchedCount: 0,
            moves: 0,
            locked: false
          };

          rooms.set(roomCode, room);

          room.players.forEach((player, idx) => {

            send(player, {
              type: 'match_found',
              roomCode
            });

            send(player, {
              type: 'game_start',
              yourIndex: idx
            });

            send(player, {
              type: 'full_state',

              yourIndex: idx,

              state: {
                gridSize: room.gridSize,
                totalPairs: room.totalPairs,
                deck: room.deck,

                curPlayer: room.curPlayer,
                scores: room.scores,
                streaks: room.streaks,

                matchedCount: room.matchedCount,
                moves: room.moves,
                locked: room.locked
              }
            });

          });

          playerRoom = roomCode;
          playerIndex = 1;

        } else {

          waitingPlayers.add(ws);

          send(ws, {
            type: 'searching'
          });

        }

        break;
      }

      // ========================
      // CANCEL SEARCH
      // ========================

      case 'cancel_search': {

        waitingPlayers.delete(ws);

        send(ws, {
          type: 'search_cancelled'
        });

        break;
      }

      // ========================
      // FLIP CARD
      // ========================

      case 'flip_card': {

        if (!playerRoom || !rooms.has(playerRoom)) return;

        const room = rooms.get(playerRoom);

        if (room.locked) return;

        if (room.curPlayer !== playerIndex + 1) return;

        const index = msg.cardIndex;

        const card = room.deck[index];

        if (!card) return;
        if (card.flipped || card.matched) return;

        card.flipped = true;

        room.flipped.push(index);

        broadcast(room, {
          type: 'card_flipped',
          index,
          emoji: card.emoji
        });

        if (room.flipped.length < 2) return;

        room.locked = true;

        room.moves++;

        const [i1, i2] = room.flipped;

        const c1 = room.deck[i1];
        const c2 = room.deck[i2];

        if (c1.emoji === c2.emoji) {

          c1.matched = true;
          c2.matched = true;

          room.matchedCount++;

          room.scores[playerIndex]++;

          room.streaks[playerIndex]++;

          broadcast(room, {
            type: 'cards_matched',

            i1,
            i2,

            owner: playerIndex,

            scores: room.scores,

            curPlayer: room.curPlayer,

            matchedCount: room.matchedCount
          });

          room.flipped = [];
          room.locked = false;

          if (room.matchedCount >= room.totalPairs) {

            broadcast(room, {
              type: 'game_over',
              scores: room.scores
            });

          }

        } else {

          room.streaks = [0, 0];

          broadcast(room, {
            type: 'cards_mismatch',
            i1,
            i2
          });

          setTimeout(() => {

            c1.flipped = false;
            c2.flipped = false;

            room.flipped = [];

            room.curPlayer =
              room.curPlayer === 1 ? 2 : 1;

            room.locked = false;

            broadcast(room, {
              type: 'turn_update',

              curPlayer: room.curPlayer,

              scores: room.scores,

              streaks: room.streaks,

              hideCards: [i1, i2]
            });

          }, 1200);

        }

        break;
      }

      // ========================
      // NEW GAME
      // ========================

      case 'new_game': {

        if (!playerRoom || !rooms.has(playerRoom)) return;

        const room = rooms.get(playerRoom);

        room.deck = createDeck(room.gridSize);

        room.flipped = [];

        room.curPlayer = 1;

        room.scores = [0, 0];
        room.streaks = [0, 0];

        room.matchedCount = 0;
        room.moves = 0;
        room.locked = false;

        room.players.forEach((player, idx) => {

          send(player, {
            type: 'full_state',

            yourIndex: idx,

            state: {
              gridSize: room.gridSize,
              totalPairs: room.totalPairs,
              deck: room.deck,

              curPlayer: room.curPlayer,
              scores: room.scores,
              streaks: room.streaks,

              matchedCount: room.matchedCount,
              moves: room.moves,
              locked: room.locked
            }
          });

        });

        break;
      }

    }

  });

  ws.on('close', () => {

    console.log('Client disconnected');

    waitingPlayers.delete(ws);

    if (playerRoom && rooms.has(playerRoom)) {

      const room = rooms.get(playerRoom);

      room.players.forEach((player) => {

        if (
          player !== ws &&
          player.readyState === WebSocket.OPEN
        ) {

          send(player, {
            type: 'opponent_left'
          });

        }

      });

      rooms.delete(playerRoom);
    }

  });

});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
