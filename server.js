const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');

// CONFIGURAZIONE PORTA PER ONLINE (RENDER) O LOCALE
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use('/carte', express.static(path.join(__dirname, 'carte')));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// --- GESTIONE STANZE (MULTITAVOLO) ---
// Ogni stanza avrà il suo stato indipendente
const rooms = {}; 

const SUITS = ['denari', 'coppe', 'spade', 'bastoni'];

// --- CLASSE PARTITA (Stato Iniziale di ogni tavolo) ---
function createRoomState() {
    return {
        players: [],
        deck: [],
        tableCards: [],
        gameState: "LOBBY",
        previousState: "",
        roundCardsCount: 5,
        currentPlayerIndex: 0,
        dealerIndex: 0,
        firstPlayerIndex: 0,
        isProcessing: false,
        gameSettings: { lives: 5, blindMode: false },
        bonusLifeUsed: false,
        bonusUsedBy: null
    };
}

// --- UTILS ---
function createDeck() {
  let d = [];
  SUITS.forEach(suit => {
    for (let i = 1; i <= 10; i++) d.push({ suit, value: i, id: `${suit}-${i}` });
  });
  return d;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getCardPower(card, isAssoHigh = false) {
  if (card.suit === 'denari' && card.value === 1) return isAssoHigh ? 9999 : -1;
  let p = 0;
  if (card.suit === 'denari') p = 400;
  else if (card.suit === 'coppe') p = 300;
  else if (card.suit === 'spade') p = 200;
  else if (card.suit === 'bastoni') p = 100;
  return p + card.value;
}

function getNextAliveIndex(currentIndex, players) {
    let next = (currentIndex + 1) % players.length;
    let loopCount = 0;
    while (players[next].lives <= 0 && loopCount < players.length) {
        next = (next + 1) % players.length;
        loopCount++;
    }
    return next;
}

// --- LOGICA SERVER ---
io.on('connection', (socket) => {
  
  // Quando uno si disconnette
  socket.on('disconnect', () => {
      // Recuperiamo la stanza salvata nel socket
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;

      const room = rooms[roomName];
      const index = room.players.findIndex(p => p.id === socket.id);
      
      if (index !== -1) {
          if (room.gameState === "LOBBY") {
              room.players.splice(index, 1);
              // Se la stanza è vuota, potremmo cancellarla, ma node lo gestisce
              if(room.players.length === 0) delete rooms[roomName];
              else broadcastUpdate(roomName); 
          }
      }
  });

  socket.on('sendChat', (message) => {
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;
      
      const p = rooms[roomName].players.find(x => x.id === socket.id);
      if (p) {
          io.to(roomName).emit('chatMessage', { name: p.name, text: message, id: p.id });
      }
  });

  // JOIN (Ora accetta anche roomName)
  socket.on('join', (data) => {
      const { name, roomName } = data;
      const sanitizedRoom = roomName.trim().toUpperCase(); // Normalizza nome stanza
      
      socket.join(sanitizedRoom); // Socket.io gestisce i canali
      socket.roomName = sanitizedRoom; // Salviamo la stanza nel socket per dopo

      // Crea stanza se non esiste
      if (!rooms[sanitizedRoom]) {
          rooms[sanitizedRoom] = createRoomState();
      }
      
      const room = rooms[sanitizedRoom];

      // Riconnessione
      const ex = room.players.find(p => p.name === name);
      if (ex) {
          ex.id = socket.id; 
          socket.emit('reconnectData', {
              myId: ex.id, hand: ex.hand, gameState: room.gameState,
              isMyTurn: (room.players[room.currentPlayerIndex]?.id === ex.id),
              players: room.players.map(p => ({ id: p.id, name: p.name, lives: p.lives, lastBid: p.bid, lastWon: p.tricksWon })),
              table: room.tableCards, phase: room.gameState, roundCards: room.roundCardsCount,
              bonusInfo: { used: room.bonusLifeUsed, by: room.bonusUsedBy },
              isHost: (room.players[0].id === ex.id)
          });
          
          if (room.roundCardsCount === 1 && room.gameSettings.blindMode && room.gameState !== 'LOBBY') {
               socket.emit('blindRoundInfo', room.players.map(p => ({id: p.id, card: (p.lives > 0 && p.hand.length > 0) ? p.hand[0] : null})));
          }
          return;
      }

      // Nuovo Giocatore
      if (room.gameState !== "LOBBY") return socket.emit('errorMsg', 'Partita già iniziata in questo tavolo!');
      
      if (!room.players.find(p => p.id === socket.id)) {
          room.players.push({ id: socket.id, name: name, lives: 5, hand: [], bid: null, tricksWon: 0 });
      }
      
      broadcastUpdate(sanitizedRoom);
  });

  socket.on('startGame', (options) => {
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;
      const room = rooms[roomName];

      if (room.players[0].id !== socket.id) return;
      if (room.players.length < 2) return socket.emit('errorMsg', 'Minimo 2 giocatori!');
      
      room.gameSettings.lives = parseInt(options.lives) || 5;
      room.gameSettings.blindMode = options.blindMode || false;

      room.gameState = "BIDDING";
      room.bonusLifeUsed = false; 
      room.bonusUsedBy = null;
      
      room.players.forEach(p => {
          p.lives = room.gameSettings.lives;
          p.hand = [];
          p.bid = null;
          p.tricksWon = 0;
      });

      room.dealerIndex = Math.floor(Math.random() * room.players.length);
      room.roundCardsCount = 5; 
      
      io.to(roomName).emit('updateBonus', { used: false, by: null });
      startRound(roomName);
  });

  socket.on('togglePause', () => {
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;
      const room = rooms[roomName];

      if (room.gameState === "PAUSED") {
          room.gameState = room.previousState;
          io.to(roomName).emit('gamePaused', false);
          updateGameState(roomName); 
      } else {
          room.previousState = room.gameState;
          room.gameState = "PAUSED";
          io.to(roomName).emit('gamePaused', true);
      }
  });

  socket.on('placeBid', (bid) => {
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;
      const room = rooms[roomName];

      if (room.gameState === "PAUSED") return;
      if (room.players[room.currentPlayerIndex].id !== socket.id) return;
      
      if (room.currentPlayerIndex === room.dealerIndex) {
        let activePlayers = room.players.filter(p => p.lives > 0);
        let currentBids = activePlayers.reduce((sum, p) => sum + (p.bid || 0), 0);
        if (currentBids + bid === room.roundCardsCount) return socket.emit('errorMsg', "Somma vietata!");
      }
      
      room.players.find(p => p.id === socket.id).bid = bid;
      broadcastUpdate(roomName);
      nextTurn(roomName, 'BIDDING');
  });

  socket.on('playCard', (data) => {
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;
      const room = rooms[roomName];

      if (room.gameState === "PAUSED" || room.isProcessing) return;
      if (room.players[room.currentPlayerIndex].id !== socket.id) return;
      
      const p = room.players.find(x => x.id === socket.id);
      const c = p.hand[data.cardIndex];
      p.hand.splice(data.cardIndex, 1);
      
      let isHigh = (c.suit === 'denari' && c.value === 1 && data.assoChoice === 'HIGH');
      room.tableCards.push({ playerId: p.id, card: c, isAssoHigh: isHigh, playerName: p.name });
      
      io.to(roomName).emit('tableUpdate', room.tableCards);
      io.to(p.id).emit('updateHand', p.hand); 
      
      nextTurn(roomName, 'PLAYING');
  });
});

// --- HELPER FUNCTIONS (Ora richiedono roomName) ---

function broadcastUpdate(roomName) {
    const room = rooms[roomName];
    room.players.forEach(p => {
        io.to(p.id).emit('updatePlayers', {
            list: room.players.map(pl => ({ id: pl.id, name: pl.name, lives: pl.lives, lastBid: pl.bid, lastWon: pl.tricksWon })),
            isHost: (room.players.length > 0 && room.players[0].id === p.id) 
        });
    });
}

function startRound(roomName) {
  const room = rooms[roomName];
  room.deck = shuffle(createDeck());
  room.tableCards = [];
  room.isProcessing = false;
  
  room.players.forEach(p => {
    p.bid = null; 
    p.tricksWon = 0;
    if (p.lives > 0) {
        p.hand = room.deck.splice(0, room.roundCardsCount);
    } else {
        p.hand = [];
    }
  });

  if (room.roundCardsCount === 1 && room.gameSettings.blindMode) {
      io.to(roomName).emit('blindRoundStart', room.players.map(p => ({
          id: p.id, 
          card: (p.lives > 0) ? p.hand[0] : null
      })));
      room.players.forEach(p => {
          if (p.lives > 0) io.to(p.id).emit('updateHand', p.hand); 
      });
  } else {
      io.to(roomName).emit('clearBlindCards'); 
      room.players.forEach(p => {
          if (p.lives > 0) io.to(p.id).emit('updateHand', p.hand);
          else io.to(p.id).emit('updateHand', []);
      });
  }
  
  room.firstPlayerIndex = getNextAliveIndex(room.dealerIndex, room.players);
  room.currentPlayerIndex = room.firstPlayerIndex;
  
  broadcastUpdate(roomName);
  updateGameState(roomName);
}

function nextTurn(roomName, phase) {
  const room = rooms[roomName];
  if (phase === 'BIDDING') {
    room.currentPlayerIndex = getNextAliveIndex(room.currentPlayerIndex, room.players);
    if (room.currentPlayerIndex === room.firstPlayerIndex) { updateGameState(roomName, "PLAYING"); return; }
    updateGameState(roomName, "BIDDING");
  } 
  else if (phase === 'PLAYING') {
    let aliveCount = room.players.filter(p => p.lives > 0).length;
    if (room.tableCards.length === aliveCount) evaluateTrick(roomName);
    else { room.currentPlayerIndex = getNextAliveIndex(room.currentPlayerIndex, room.players); updateGameState(roomName, "PLAYING"); }
  }
}

function evaluateTrick(roomName) {
    const room = rooms[roomName];
    room.isProcessing = true;
    let winner = room.tableCards[0], maxP = getCardPower(winner.card, winner.isAssoHigh);
    for (let i = 1; i < room.tableCards.length; i++) {
        let p = getCardPower(room.tableCards[i].card, room.tableCards[i].isAssoHigh);
        if (p > maxP) { winner = room.tableCards[i]; maxP = p; }
    }
    const wPlayer = room.players.find(p => p.id === winner.playerId);
    wPlayer.tricksWon++; 
    
    io.to(roomName).emit('trickResult', `Presa: ${wPlayer.name}`);
    broadcastUpdate(roomName);
    
    const waitTime = (room.roundCardsCount === 1) ? 4000 : 2500;

    setTimeout(() => {
        if(!rooms[roomName]) return; // Check se la stanza esiste ancora
        room.tableCards = []; io.to(roomName).emit('tableUpdate', []);
        io.to(roomName).emit('clearBlindCards'); 
        room.currentPlayerIndex = room.players.findIndex(p => p.id === winner.playerId);
        if (room.players[room.currentPlayerIndex].hand.length === 0) endRoundLogic(roomName);
        else { room.isProcessing = false; updateGameState(roomName, "PLAYING"); }
    }, waitTime); 
}

function endRoundLogic(roomName) {
    const room = rooms[roomName];
    room.isProcessing = true;
    let reportMsg = "📉 <b>RISULTATI TURNO</b> 📉<br>";

    // CAPPOTTO
    const cappottoPlayer = room.players.find(p => p.lives > 0 && p.bid === room.roundCardsCount && p.tricksWon === room.roundCardsCount);
    
    if (cappottoPlayer && room.roundCardsCount > 1) {
        room.players.filter(p => p.lives > 0).forEach(p => {
            if (p.id !== cappottoPlayer.id) p.lives -= 1;
        });
        reportMsg += `<span style='color:red'>🔥 CAPPOTTO DI ${cappottoPlayer.name.toUpperCase()}! GLI ALTRI -1!</span><br>`;
    } else {
        let anyDamage = false;
        room.players.filter(p => p.lives > 0).forEach(p => {
            let diff = Math.abs(p.bid - p.tricksWon);
            if (diff > 0) {
                p.lives -= diff;
                reportMsg += `${p.name}: <span style='color:#ff4444'>-${diff} ❤️</span><br>`;
                anyDamage = true;
            } else {
                reportMsg += `${p.name}: <span style='color:#44ff44'>Salvo</span><br>`;
            }
        });
        if(!anyDamage) reportMsg += "Nessun danno!<br>";
    }

    // BONUS VITA
    let dyingPlayers = room.players.filter(p => p.lives <= 0);
    if (dyingPlayers.length > 0) {
        if (!room.bonusLifeUsed) {
            dyingPlayers.forEach(p => p.lives += 1);
            room.bonusLifeUsed = true;
            room.bonusUsedBy = dyingPlayers.map(p => p.name).join(", ");
            reportMsg += `<br>✨ <b>BONUS ATTIVATO!</b><br>Per: ${room.bonusUsedBy}`;
            io.to(roomName).emit('updateBonus', { used: true, by: room.bonusUsedBy });
            
            let trulyDead = dyingPlayers.filter(p => p.lives <= 0);
            if(trulyDead.length > 0) reportMsg += `<br>💀 NON È BASTATO A: ${trulyDead.map(p=>p.name).join(', ')}`;

        } else {
            reportMsg += `<br>💀 <b>ELIMINATI:</b> ${dyingPlayers.map(p=>p.name).join(', ')}`;
        }
    }

    io.to(roomName).emit('statusMsg', reportMsg);

    // VINCITORE
    let active = room.players.filter(p => p.lives > 0);
    if (active.length === 0) {
        setTimeout(() => io.to(roomName).emit('statusMsg', "Tutti morti! SPAREGGIO!"), 3000);
        room.players.forEach(p => p.lives = 1);
        active = room.players;
    }

    if (active.length === 1) {
        setTimeout(() => {
            io.to(roomName).emit('gameOver', `🏆 VINCE ${active[0].name.toUpperCase()}! 🏆`);
            setTimeout(() => { resetGame(roomName); }, 5000);
        }, 4000);
        return;
    }

    room.roundCardsCount--;
    if (active.length === 2 && room.roundCardsCount === 1) {
        room.roundCardsCount = 5; 
        reportMsg += "<br>(Siamo in 2: Saltato turno da 1)";
        io.to(roomName).emit('statusMsg', reportMsg); 
    } else if (room.roundCardsCount < 1) {
        room.roundCardsCount = 5;
    }
    
    room.dealerIndex = getNextAliveIndex(room.dealerIndex, room.players);
    broadcastUpdate(roomName);
    
    setTimeout(() => {
        if(rooms[roomName]) { // Check esistenza
            io.to(roomName).emit('statusMsg', `Nuovo Round: ${room.roundCardsCount} carte`);
            room.isProcessing = false;
            startRound(roomName);
        }
    }, 6000);
}

function resetGame(roomName) {
    if(!rooms[roomName]) return;
    const room = rooms[roomName];
    room.gameState = "LOBBY";
    room.tableCards = [];
    room.bonusLifeUsed = false;
    room.bonusUsedBy = null;
    room.isProcessing = false;
    
    room.players.forEach(p => {
        p.lives = 5; 
        p.hand = [];
        p.bid = null;
        p.tricksWon = 0;
    });

    io.to(roomName).emit('backToLobby'); 
    broadcastUpdate(roomName);      
}

function updateGameState(roomName, force) {
    const room = rooms[roomName];
    if (room.gameState === "PAUSED") return;
    if (force) room.gameState = force;
    else if (!room.players[room.firstPlayerIndex] || room.players[room.firstPlayerIndex].bid === null) room.gameState = "BIDDING"; 
    else room.gameState = "PLAYING";

    let msg = room.gameState === "BIDDING" ? `Scommetti: ${room.players[room.currentPlayerIndex].name}` : `Gioca: ${room.players[room.currentPlayerIndex].name}`;
    io.to(roomName).emit('statusMsg', msg);
    io.to(roomName).emit('turnUpdate', { playerId: room.players[room.currentPlayerIndex].id, phase: room.gameState, roundCards: room.roundCardsCount });
}

server.listen(PORT, () => { console.log(`SERVER ATTIVO SULLA PORTA ${PORT}`); });