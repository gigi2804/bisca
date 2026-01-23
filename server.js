const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use('/carte', express.static(path.join(__dirname, 'carte')));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

console.log("SERVER AVVIATO: Logica Salto 5 Giocatori (Smart Memory)");

const rooms = {}; 
const SUITS = ['denari', 'coppe', 'spade', 'bastoni'];

function createRoomState() {
    return {
        players: [], deck: [], tableCards: [],
        gameState: "LOBBY", previousState: "",
        roundCardsCount: 5,
        currentPlayerIndex: 0, dealerIndex: 0, firstPlayerIndex: 0,
        isProcessing: false,
        gameSettings: { lives: 5, blindMode: false },
        bonusLifeUsed: false, bonusUsedBy: null,
        restartVotes: new Set(),
        lastRoundPlayerCount: 0 // NUOVO: Memoria per il salto mazziere
    };
}

function createDeck() {
  let d = [];
  SUITS.forEach(suit => { for (let i = 1; i <= 10; i++) d.push({ suit, value: i, id: `${suit}-${i}` }); });
  return d;
}
function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
function getCardPower(c, isAssoHigh) {
  if (c.suit === 'denari' && c.value === 1) return isAssoHigh ? 9999 : -1;
  let p = c.suit === 'denari' ? 400 : c.suit === 'coppe' ? 300 : c.suit === 'spade' ? 200 : 100;
  return p + c.value;
}
function getNextAliveIndex(curr, players) {
    if(!players || players.length === 0) return 0;
    let next = (curr + 1) % players.length;
    let loopCount = 0;
    while (players[next] && players[next].lives <= 0 && loopCount < players.length) { 
        next = (next + 1) % players.length; 
        loopCount++; 
    }
    return next;
}

io.on('connection', (socket) => {
  socket.on('disconnect', () => { handleLeave(socket); });
  socket.on('leaveRoom', () => { handleLeave(socket); });

  function handleLeave(sock) {
      try {
          const roomName = sock.roomName;
          if (!roomName || !rooms[roomName]) return;
          const room = rooms[roomName];
          room.restartVotes.delete(sock.id);
          const index = room.players.findIndex(p => p.id === sock.id);
          if (index !== -1) {
              if (room.gameState === "LOBBY") {
                  room.players.splice(index, 1);
                  if(room.players.length === 0) delete rooms[roomName];
                  else broadcastUpdate(roomName); 
              }
          }
      } catch (e) { console.error(e); }
  }

  socket.on('switchRole', (wantsToPlay) => {
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;
      const room = rooms[roomName];
      const p = room.players.find(x => x.id === socket.id);
      if(p) {
          if (wantsToPlay) {
              const activePlayers = room.players.filter(x => !x.isSpectator).length;
              if (activePlayers < 8) {
                  p.isSpectator = false;
                  p.lives = 5; 
              } else {
                  socket.emit('warning', "Tavolo pieno! Rimani spettatore.");
                  p.isSpectator = true;
              }
          } else {
              p.isSpectator = true;
              p.lives = 0;
          }
          broadcastUpdate(roomName);
      }
  });

  socket.on('voteRestart', () => {
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;
      const room = rooms[roomName];
      const p = room.players.find(x => x.id === socket.id);
      if (!p || p.isSpectator) return;
      if (room.restartVotes.has(socket.id)) return; 

      room.restartVotes.add(socket.id);
      const activePlayersCount = room.players.filter(pl => !pl.isSpectator).length;
      const votes = room.restartVotes.size;

      io.to(roomName).emit('statusMsg', `🔄 Voto Reset: ${votes}/${activePlayersCount}`);

      if (votes >= activePlayersCount) {
          io.to(roomName).emit('statusMsg', `✅ RESET APPROVATO!`);
          setTimeout(() => resetGame(roomName), 1500);
      }
  });

  socket.on('leaveGame', () => {
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;
      const room = rooms[roomName];
      const p = room.players.find(x => x.id === socket.id);
      if (p && p.lives > 0) {
          p.lives = 0; 
          io.to(roomName).emit('statusMsg', `<span style="color:red">🏳️ ${p.name} HA ABBANDONATO!</span>`);
          if (room.gameState === "PLAYING" || room.gameState === "BIDDING") {
              room.isProcessing = true; 
              setTimeout(() => endRoundLogic(roomName, true), 1000);
          } else { broadcastUpdate(roomName); }
      } else if (p) { socket.emit('errorMsg', "Sei uscito dalla partita."); }
  });

  socket.on('sendChat', (message) => {
      const roomName = socket.roomName;
      if (!roomName || !rooms[roomName]) return;
      const p = rooms[roomName].players.find(x => x.id === socket.id);
      if (p) io.to(roomName).emit('chatMessage', { name: p.name, text: message, id: p.id });
  });

  socket.on('join', (data) => {
      try {
          const { name, roomName } = data;
          if(!name || !roomName) return;
          const sanitizedRoom = roomName.trim().toUpperCase();
          socket.join(sanitizedRoom); socket.roomName = sanitizedRoom;

          if (!rooms[sanitizedRoom]) rooms[sanitizedRoom] = createRoomState();
          const room = rooms[sanitizedRoom];

          const ex = room.players.find(p => p.name === name);
          if (ex) {
              ex.id = socket.id; 
              if(room.restartVotes.has(ex.id)) { room.restartVotes.delete(ex.id); room.restartVotes.add(socket.id); }
              socket.emit('reconnectData', { myId: ex.id, hand: ex.hand, gameState: room.gameState, isMyTurn: (room.players[room.currentPlayerIndex]?.id === ex.id), players: room.players.map(p => ({ id: p.id, name: p.name, lives: p.lives, lastBid: p.bid, lastWon: p.tricksWon })), table: room.tableCards, phase: room.gameState, roundCards: room.roundCardsCount, bonusInfo: { used: room.bonusLifeUsed, by: room.bonusUsedBy }, isHost: (room.players[0].id === ex.id) });
              if (room.roundCardsCount === 1 && room.gameSettings.blindMode && room.gameState !== 'LOBBY') socket.emit('blindRoundInfo', room.players.map(p => ({id: p.id, card: (p.lives > 0 && p.hand.length > 0) ? p.hand[0] : null})));
              return;
          }

          let isSpectator = false;
          if (room.gameState !== "LOBBY") {
             isSpectator = true;
             socket.emit('statusMsg', "Partita in corso. Entrato come Spettatore.");
          }

          if (room.players.length >= 8 && !isSpectator) return socket.emit('errorMsg', 'Tavolo Pieno! Massimo 8 giocatori.');

          if (!room.players.find(p => p.id === socket.id)) {
              room.players.push({ id: socket.id, name, lives: isSpectator ? 0 : 5, hand: [], bid: null, tricksWon: 0, isSpectator: isSpectator });
          }
          
          if (isSpectator) {
               socket.emit('reconnectData', { myId: socket.id, hand: [], gameState: room.gameState, isMyTurn: false, players: room.players.map(p => ({ id: p.id, name: p.name, lives: p.lives, lastBid: p.bid, lastWon: p.tricksWon })), table: room.tableCards, phase: room.gameState, roundCards: room.roundCardsCount, bonusInfo: { used: room.bonusLifeUsed, by: room.bonusUsedBy }, isHost: false });
               if (room.roundCardsCount === 1 && room.gameSettings.blindMode) socket.emit('blindRoundInfo', room.players.map(p => ({id: p.id, card: (p.lives > 0 && p.hand.length > 0) ? p.hand[0] : null})));
          }
          broadcastUpdate(sanitizedRoom);
      } catch(e) { console.error(e); }
  });

  socket.on('startGame', (opts) => {
      try {
          const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return;
          const room = rooms[roomName];
          if (room.players[0].id !== socket.id || room.players.length < 2) return socket.emit('errorMsg', 'Minimo 2 giocatori!');
          room.gameSettings.lives = parseInt(opts.lives)||5; room.gameSettings.blindMode = opts.blindMode||false;
          room.gameState = "BIDDING"; room.bonusLifeUsed = false; room.bonusUsedBy = null;
          room.restartVotes.clear(); 
          
          let activePlayersCount = 0;
          room.players.forEach(p => { 
              if (!p.isSpectator) { 
                  p.lives = room.gameSettings.lives; 
                  p.hand = []; p.bid = null; p.tricksWon = 0; 
                  activePlayersCount++;
              } 
              else { p.lives = 0; p.hand = []; }
          });
          
          // SALVA IL NUMERO INIZIALE DI GIOCATORI PER LA LOGICA MAZZIERE
          room.lastRoundPlayerCount = activePlayersCount;

          room.dealerIndex = Math.floor(Math.random() * room.players.length); room.roundCardsCount = 5; 
          io.to(roomName).emit('updateBonus', { used: false, by: null }); startRound(roomName);
      } catch(e) { console.error(e); }
  });

  socket.on('togglePause', () => {
      const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return;
      const room = rooms[roomName];
      if(room.gameState==="PAUSED"){ room.gameState=room.previousState; io.to(roomName).emit('gamePaused', false); updateGameState(roomName); }
      else { room.previousState=room.gameState; room.gameState="PAUSED"; io.to(roomName).emit('gamePaused', true); }
  });

  socket.on('placeBid', (bid) => {
      try {
          const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return;
          const room = rooms[roomName];
          if(room.gameState==="PAUSED" || !room.players[room.currentPlayerIndex] || room.players[room.currentPlayerIndex].id !== socket.id) return;
          if(room.currentPlayerIndex === room.dealerIndex && room.players.filter(p=>p.lives>0).reduce((s,p)=>s+(p.bid||0),0)+bid===room.roundCardsCount) {
              return socket.emit('warning', "⚠️ Il mazziere non può chiamare questo numero!");
          }
          room.players.find(p=>p.id===socket.id).bid = bid; broadcastUpdate(roomName); nextTurn(roomName, 'BIDDING');
      } catch(e) { console.error(e); }
  });

  socket.on('playCard', (data) => {
      try {
          const roomName = socket.roomName; if (!roomName || !rooms[roomName]) return;
          const room = rooms[roomName];
          if(room.gameState==="PAUSED" || room.isProcessing || !room.players[room.currentPlayerIndex] || room.players[room.currentPlayerIndex].id !== socket.id) return;
          const p = room.players.find(x=>x.id===socket.id), c = p.hand[data.cardIndex];
          p.hand.splice(data.cardIndex, 1);
          let isHigh = (c.suit==='denari'&&c.value===1&&data.assoChoice==='HIGH');
          room.tableCards.push({ playerId: p.id, card: c, isAssoHigh: isHigh, playerName: p.name });
          io.to(roomName).emit('tableUpdate', room.tableCards); io.to(p.id).emit('updateHand', p.hand); nextTurn(roomName, 'PLAYING');
      } catch(e) { console.error(e); }
  });
});

function broadcastUpdate(roomName) {
    const room = rooms[roomName];
    if(!room) return;
    room.players.forEach(p => {
        io.to(p.id).emit('updatePlayers', {
            list: room.players.map(pl => ({ id: pl.id, name: pl.name, lives: pl.lives, lastBid: pl.bid, lastWon: pl.tricksWon, isSpectator: pl.isSpectator })),
            isHost: (room.players.length > 0 && room.players[0].id === p.id) 
        });
    });
}
function startRound(roomName) {
  const room = rooms[roomName];
  room.deck = shuffle(createDeck()); room.tableCards = []; room.isProcessing = false;
  room.players.forEach(p => { p.bid = null; p.tricksWon = 0; if (p.lives > 0) p.hand = room.deck.splice(0, room.roundCardsCount); else p.hand = []; });
  if (room.roundCardsCount === 1 && room.gameSettings.blindMode) { io.to(roomName).emit('blindRoundStart', room.players.map(p => ({ id: p.id, card: (p.lives > 0) ? p.hand[0] : null }))); room.players.forEach(p => { if (p.lives > 0) io.to(p.id).emit('updateHand', p.hand); }); } 
  else { io.to(roomName).emit('clearBlindCards'); room.players.forEach(p => { if (p.lives > 0) io.to(p.id).emit('updateHand', p.hand); else io.to(p.id).emit('updateHand', []); }); }
  room.firstPlayerIndex = getNextAliveIndex(room.dealerIndex, room.players); room.currentPlayerIndex = room.firstPlayerIndex; broadcastUpdate(roomName); updateGameState(roomName);
}
function nextTurn(roomName, phase) {
  const room = rooms[roomName];
  if (phase === 'BIDDING') { room.currentPlayerIndex = getNextAliveIndex(room.currentPlayerIndex, room.players); if (room.currentPlayerIndex === room.firstPlayerIndex) { updateGameState(roomName, "PLAYING"); return; } updateGameState(roomName, "BIDDING"); } 
  else { if (room.tableCards.length === room.players.filter(p => p.lives > 0).length) evaluateTrick(roomName); else { room.currentPlayerIndex = getNextAliveIndex(room.currentPlayerIndex, room.players); updateGameState(roomName, "PLAYING"); } }
}

function evaluateTrick(roomName) {
    const room = rooms[roomName];
    room.isProcessing = true;
    let winner = room.tableCards[0], maxP = getCardPower(winner.card, winner.isAssoHigh);
    for (let i = 1; i < room.tableCards.length; i++) { let p = getCardPower(room.tableCards[i].card, room.tableCards[i].isAssoHigh); if (p > maxP) { winner = room.tableCards[i]; maxP = p; } }
    
    let wPlayer = room.players.find(p => p.id === winner.playerId);
    let winnerName = room.players.find(p => p.id === winner.playerId)?.name || "Sconosciuto";
    io.to(roomName).emit('trickResult', `Presa: ${winnerName}`); 
    
    const waitTime = (room.roundCardsCount === 1) ? 8000 : 4000;
    setTimeout(() => {
        try {
            if(!rooms[roomName]) return;
            const r = rooms[roomName]; 
            if(wPlayer) wPlayer.tricksWon++;
            broadcastUpdate(roomName);
            r.tableCards = []; io.to(roomName).emit('tableUpdate', []); io.to(roomName).emit('clearBlindCards'); 
            let nextIdx = r.players.findIndex(p => p.id === winner.playerId);
            if (nextIdx === -1) nextIdx = getNextAliveIndex(0, r.players);
            r.currentPlayerIndex = nextIdx;
            if (!r.players[nextIdx] || !r.players[nextIdx].hand) { endRoundLogic(roomName); return; }
            if (r.players[nextIdx].hand.length === 0) endRoundLogic(roomName); 
            else { r.isProcessing = false; updateGameState(roomName, "PLAYING"); }
        } catch (e) { console.error(e); if(rooms[roomName]) rooms[roomName].isProcessing = false; }
    }, waitTime); 
}

function endRoundLogic(roomName, safeMode = false) {
    const room = rooms[roomName]; room.isProcessing = true; let reportMsg = "📉 <b>RISULTATI TURNO</b> 📉<br>";
    if (safeMode) {
        reportMsg += "<br>🛑 <b>TURNO INTERROTTO (ABBANDONO)</b><br>Nessuna vita persa.";
        room.players.forEach(p => { if(p.lives > 0) p.hand = []; });
    } else {
        const cappotto = room.players.find(p => p.lives>0 && p.bid===room.roundCardsCount && p.tricksWon===room.roundCardsCount);
        if (cappotto && room.roundCardsCount > 1) { room.players.filter(p=>p.lives>0).forEach(p => { if(p.id!==cappotto.id) p.lives -= 1; }); reportMsg += `<span style='color:red'>🔥 CAPPOTTO DI ${cappotto.name.toUpperCase()}! GLI ALTRI -1!</span><br>`; } 
        else { room.players.filter(p=>p.lives>0).forEach(p => { let d = Math.abs(p.bid - p.tricksWon); if (d > 0) { p.lives -= d; reportMsg += `${p.name}: <span style='color:#ff4444'>-${d} ❤️</span><br>`; } else { reportMsg += `${p.name}: <span style='color:#44ff44'>Salvo</span><br>`; } }); }
    }

    let dying = room.players.filter(p => p.lives <= 0);
    if (dying.length > 0) {
        if (!room.bonusLifeUsed && !safeMode) { dying.forEach(p => p.lives += 1); room.bonusLifeUsed = true; room.bonusUsedBy = dying.map(p => p.name).join(", "); reportMsg += `<br>✨ <b>BONUS ATTIVATO!</b><br>Per: ${room.bonusUsedBy}`; io.to(roomName).emit('updateBonus', { used: true, by: room.bonusUsedBy }); }
        else { reportMsg += `<br>💀 <b>ELIMINATI:</b> ${dying.map(p=>p.name).join(', ')}`; }
    }
    io.to(roomName).emit('statusMsg', reportMsg);
    
    let active = room.players.filter(p => p.lives > 0);
    if (active.length === 0) { setTimeout(() => io.to(roomName).emit('statusMsg', "Tutti morti! SPAREGGIO!"), 3000); room.players.forEach(p => p.lives = 1); active = room.players; }
    if (active.length === 1) { setTimeout(() => { io.to(roomName).emit('gameOver', `🏆 VINCE ${active[0].name.toUpperCase()}! 🏆`); setTimeout(() => resetGame(roomName), 5000); }, 4000); return; }
    
    room.roundCardsCount--; 
    
    // --- GESTIONE SALTO MAZZIERE (5 GIOCATORI) ---
    let skipDealer = false;
    if (active.length === 2 && room.roundCardsCount === 1) { 
        room.roundCardsCount = 5; 
        reportMsg += "<br>(Siamo in 2: Saltato turno da 1)"; 
        io.to(roomName).emit('statusMsg', reportMsg); 
    } else if (room.roundCardsCount < 1) {
        room.roundCardsCount = 5;
        
        // CONTA ATTUALE GIOCATORI VIVI
        const currentActiveCount = room.players.filter(p => p.lives > 0).length;
        
        // LOGICA MEMORIA:
        // Se ORA siamo 5 E ANCHE L'ULTIMA VOLTA eravamo 5 -> SALTA.
        // Se prima eravamo 6 e ora siamo 5 -> NON SALTA (aggiorna solo la memoria).
        if (currentActiveCount === 5 && room.lastRoundPlayerCount === 5) {
            skipDealer = true;
        }
        
        // AGGIORNA LA MEMORIA PER IL PROSSIMO GIRO
        room.lastRoundPlayerCount = currentActiveCount;
    }

    room.dealerIndex = getNextAliveIndex(room.dealerIndex, room.players);
    
    if (skipDealer) {
        // Applica il salto
        room.dealerIndex = getNextAliveIndex(room.dealerIndex, room.players);
        setTimeout(() => io.to(roomName).emit('statusMsg', "🔀 Giro bloccato in 5: Il Mazziere salta uno!"), 2000);
    }

    broadcastUpdate(roomName);
    setTimeout(() => { if(rooms[roomName]) { io.to(roomName).emit('statusMsg', `Nuovo Round: ${room.roundCardsCount} carte`); room.isProcessing = false; startRound(roomName); } }, 6000);
}

function resetGame(roomName) { 
    if(!rooms[roomName]) return; 
    const r = rooms[roomName]; 
    r.gameState="LOBBY"; r.tableCards=[]; r.bonusLifeUsed=false; r.bonusUsedBy=null; r.isProcessing=false; r.restartVotes.clear(); 
    r.players.forEach(p => { p.lives=5; p.hand=[]; p.bid=null; p.tricksWon=0; }); 
    io.to(roomName).emit('backToLobby'); broadcastUpdate(roomName); 
}

function updateGameState(roomName, force) { const r = rooms[roomName]; if (r.gameState === "PAUSED") return; if(force) r.gameState=force; else if (!r.players[r.firstPlayerIndex] || r.players[r.firstPlayerIndex].bid === null) r.gameState = "BIDDING"; else r.gameState = "PLAYING"; let msg = r.gameState === "BIDDING" ? `Scommetti: ${r.players[r.currentPlayerIndex].name}` : `Gioca: ${r.players[r.currentPlayerIndex].name}`; io.to(roomName).emit('statusMsg', msg); io.to(roomName).emit('turnUpdate', { playerId: r.players[r.currentPlayerIndex].id, phase: r.gameState, roundCards: r.roundCardsCount }); }
server.listen(PORT, () => console.log(`SERVER PORT ${PORT}`));