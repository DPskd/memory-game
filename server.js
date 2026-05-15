const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Memory Game Server OK');
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
const waitingPlayers = new Set();

// Наборы эмодзи для генерации колоды
const EMOJI_POOL = [
  '🍎','🍊','🍋','🍇','🍓','🍒','🥝','🍑','🍕','🍔','🌮','🍣',
  '🐱','🐶','🦊','🐼','🐨','🦁','🐯','🦋','🌺','🌸','🌻','🌹',
  '⚡','💎','🔮','💡','🎯','🎲','🎮','🎪'
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Создаем новое состояние игры
function createGameState(gridSize = 4) {
  const totalPairs = (gridSize * gridSize) / 2;
  const pool = shuffle(EMOJI_POOL).slice(0, totalPairs);
  const deck = shuffle([...pool, ...pool]).map((emoji, id) => ({
    id,
    emoji,
    flipped: false,
    matched: false,
    gone: false
  }));

  return {
    deck,
    gridSize,
    totalPairs,
    currentPlayer: 1, // 1 или 2
    scores: [0, 0],
    matchedCount: 0,
    flippedCards: [], // индексы перевернутых карт
    locked: false,
    gameOver: false
  };
}

// Отправка сообщения всем игрокам в комнате
function broadcast(room, msg) {
  room.players.forEach(player => {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(msg));
    }
  });
}

// Отправка сообщения конкретному игроку
function sendToPlayer(room, playerIndex, msg) {
  const player = room.players[playerIndex];
  if (player && player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(msg));
  }
}

wss.on('connection', (ws) => {
  console.log('New client connected');
  let currentRoom = null;
  let myIndex = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      // ========== СОЗДАНИЕ КОМНАТЫ ==========
      case 'create_room': {
        const roomCode = generateRoomCode();
        const room = {
          code: roomCode,
          players: [{ ws, name: 'Игрок 1' }],
          gameState: null
        };
        rooms.set(roomCode, room);
        currentRoom = roomCode;
        myIndex = 0;
        ws.send(JSON.stringify({ type: 'room_created', roomCode, yourIndex: 0 }));
        console.log(`Room ${roomCode} created by Player 1`);
        break;
      }

      // ========== ПРИСОЕДИНЕНИЕ К КОМНАТЕ ==========
      case 'join_room': {
        const room = rooms.get(msg.roomCode);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Комната не найдена' }));
          return;
        }
        if (room.players.length >= 2) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Комната заполнена' }));
          return;
        }
        room.players.push({ ws, name: 'Игрок 2' });
        currentRoom = msg.roomCode;
        myIndex = 1;

        // Создаем игру и отправляем состояние обоим
        const gs = createGameState(4);
        room.gameState = gs;

        // Отправляем каждому игроку его состояние
        sendToPlayer(room, 0, {
          type: 'game_start',
          state: gs,
          yourIndex: 0,
          playerNames: [room.players[0].name, room.players[1].name]
        });
        sendToPlayer(room, 1, {
          type: 'game_start',
          state: gs,
          yourIndex: 1,
          playerNames: [room.players[0].name, room.players[1].name]
        });

        console.log(`Game started in room ${msg.roomCode}`);
        break;
      }

      // ========== ПОИСК СОПЕРНИКА ==========
      case 'find_match': {
        if (waitingPlayers.size > 0) {
          const opponentData = Array.from(waitingPlayers)[0];
          waitingPlayers.delete(opponentData);
          const opponentWs = opponentData.ws;

          const roomCode = generateRoomCode();
          const room = {
            code: roomCode,
            players: [
              { ws: opponentWs, name: 'Игрок 1' },
              { ws, name: 'Игрок 2' }
            ],
            gameState: null
          };
          rooms.set(roomCode, room);

          const gs = createGameState(4);
          room.gameState = gs;

          // Игрок 1 (противник)
          opponentWs.send(JSON.stringify({
            type: 'game_start',
            state: gs,
            yourIndex: 0,
            playerNames: ['Игрок 1', 'Игрок 2']
          }));
          // Игрок 2 (текущий)
          ws.send(JSON.stringify({
            type: 'game_start',
            state: gs,
            yourIndex: 1,
            playerNames: ['Игрок 1', 'Игрок 2']
          }));

          currentRoom = roomCode;
          myIndex = 1;
          console.log(`Match found, room ${roomCode}`);
        } else {
          waitingPlayers.add({ ws });
          ws.send(JSON.stringify({ type: 'searching' }));
        }
        break;
      }

      // ========== ОТМЕНА ПОИСКА ==========
      case 'cancel_search': {
        waitingPlayers.forEach(p => {
          if (p.ws === ws) waitingPlayers.delete(p);
        });
        ws.send(JSON.stringify({ type: 'search_cancelled' }));
        break;
      }

      // ========== ПЕРЕВОРОТ КАРТЫ (ОСНОВНОЕ ДЕЙСТВИЕ) ==========
      case 'flip_card': {
        if (!currentRoom || !rooms.has(currentRoom)) return;
        const room = rooms.get(currentRoom);
        const gs = room.gameState;
        if (!gs || gs.gameOver) return;

        // Проверяем, что сейчас ход этого игрока
        const playerNum = myIndex + 1; // 1 или 2
        if (gs.currentPlayer !== playerNum) return;

        // Проверяем, что игра не заблокирована
        if (gs.locked) return;

        const cardIndex = msg.cardIndex;
        const card = gs.deck[cardIndex];
        if (!card || card.flipped || card.matched || card.gone) return;

        // Переворачиваем карту
        card.flipped = true;
        gs.flippedCards.push(cardIndex);

        // Сообщаем ВСЕМ игрокам о перевороте
        broadcast(room, {
          type: 'card_flipped',
          cardIndex,
          emoji: card.emoji,
          flippedBy: playerNum
        });

        // Если перевернуты 2 карты - проверяем
        if (gs.flippedCards.length === 2) {
          gs.locked = true;
          const [i1, i2] = gs.flippedCards;
          const c1 = gs.deck[i1];
          const c2 = gs.deck[i2];

          setTimeout(() => {
            if (c1.emoji === c2.emoji) {
              // СОВПАДЕНИЕ!
              c1.matched = true;
              c2.matched = true;
              gs.matchedCount++;
              const scoreIdx = gs.currentPlayer - 1;
              gs.scores[scoreIdx]++;

              broadcast(room, {
                type: 'match_found',
                indices: [i1, i2],
                player: gs.currentPlayer,
                scores: gs.scores,
                matchedCount: gs.matchedCount
              });

              // Через 400мс карты исчезают
              setTimeout(() => {
                c1.gone = true;
                c2.gone = true;
                broadcast(room, {
                  type: 'cards_removed',
                  indices: [i1, i2]
                });

                // Проверка на конец игры
                if (gs.matchedCount === gs.totalPairs) {
                  gs.gameOver = true;
                  broadcast(room, {
                    type: 'game_over',
                    scores: gs.scores
                  });
                }

                gs.flippedCards = [];
                gs.locked = false;
              }, 400);

            } else {
              // НЕ СОВПАЛИ
              broadcast(room, {
                type: 'mismatch',
                indices: [i1, i2]
              });

              setTimeout(() => {
                c1.flipped = false;
                c2.flipped = false;
                gs.flippedCards = [];

                // Переключаем игрока
                gs.currentPlayer = gs.currentPlayer === 1 ? 2 : 1;

                broadcast(room, {
                  type: 'turn_changed',
                  currentPlayer: gs.currentPlayer,
                  unflipIndices: [i1, i2]
                });

                gs.locked = false;
              }, 800);
            }
          }, 500);
        }
        break;
      }

      // ========== НОВАЯ ИГРА (РЕВАНШ) ==========
      case 'new_game': {
        if (!currentRoom || !rooms.has(currentRoom)) return;
        const room = rooms.get(currentRoom);
        const gs = createGameState(room.gameState ? room.gameState.gridSize : 4);
        room.gameState = gs;

        sendToPlayer(room, 0, {
          type: 'game_start',
          state: gs,
          yourIndex: 0,
          playerNames: [room.players[0].name, room.players[1].name]
        });
        sendToPlayer(room, 1, {
          type: 'game_start',
          state: gs,
          yourIndex: 1,
          playerNames: [room.players[0].name, room.players[1].name]
        });
        break;
      }

      // ========== УСТАНОВКА ИМЕН ==========
      case 'set_names': {
        if (!currentRoom || !rooms.has(currentRoom)) return;
        const room = rooms.get(currentRoom);
        if (msg.name1) room.players[0].name = msg.name1;
        if (msg.name2 && room.players[1]) room.players[1].name = msg.name2;
        broadcast(room, {
          type: 'names_updated',
          names: [room.players[0].name, room.players[1] ? room.players[1].name : 'Игрок 2']
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    waitingPlayers.forEach(p => {
      if (p.ws === ws) waitingPlayers.delete(p);
    });

    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      broadcast(room, { type: 'opponent_left' });
      rooms.delete(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
