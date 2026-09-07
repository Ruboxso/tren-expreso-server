/* ============================================================
   TREN EXPRESO — SERVIDOR MULTIJUGADOR
   ============================================================
   Qué hace este servidor:
     - Crear una sala (te da un código de 4 letras) y elegir mapa
     - Unirse a una sala con ese código
     - Avisar a todos los de la sala cuando alguien entra o sale
     - El anfitrión pulsa "Empezar" y arranca una partida DE VERDAD:
       el motor de reglas (engine.js) reparte cartas, valida cada
       jugada y lleva la puntuación — nadie puede hacer trampas
       porque el móvil ya no decide nada, solo pide acciones y el
       servidor dice si se pueden hacer o no.

   Lo que TODAVÍA no incluye (más adelante):
     - Las mecánicas opcionales (sabotaje, demolición, estaciones,
       enfriamiento) — de momento solo el núcleo del juego.
     - Que el propio archivo del juego (tren-express.html) se
       conecte aquí. Eso es la Fase 3.
   ============================================================ */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const engine = require('./engine');
const { verificarUsuario, obtenerPerfil, premiarPartida } = require('./supabaseAdmin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // de momento, cualquier página puede conectarse (lo cerraremos más adelante)
});

// Página de estado muy simple, solo para comprobar que el servidor está vivo
app.get('/', (req, res) => {
  res.send(`
    <h1>Tren Expreso — servidor multijugador</h1>
    <p>Estado: en marcha ✅</p>
    <p>Salas abiertas ahora mismo: ${Object.keys(rooms).length}</p>
  `);
});

/* ---------- estado en memoria de las salas ----------
   OJO: esto vive en la memoria del servidor. Si el servidor se
   reinicia (por ejemplo, Glitch "duerme" el proyecto si nadie lo
   usa un rato), las salas abiertas se pierden. Para una partida
   entre amigos esto es asumible; si algún día hiciera falta que
   sobreviva a reinicios, habría que guardar esto en una base de
   datos en vez de en una variable normal.
*/
const rooms = {}; // codigo -> { code, players:[{id,name,isHost}], started:bool, mapKey, game }
const onlineUsers = {}; // supabaseId -> socketId (solo cuentas con sesión iniciada, conectadas ahora mismo)

function generarCodigo() {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para que no se confundan al dictarlo
  let codigo;
  do {
    codigo = '';
    for (let i = 0; i < 4; i++) codigo += letras[Math.floor(Math.random() * letras.length)];
  } while (rooms[codigo]); // por si ya existe, prueba otro
  return codigo;
}

function resumenSala(room) {
  // Lo que le mandamos a los clientes: solo lo que necesitan ver, nada interno
  return {
    code: room.code,
    started: room.started,
    mapKey: room.mapKey,
    mapNames: Object.fromEntries(Object.keys(engine.MAPS_DATA).map(k => [k, engine.MAPS_DATA[k].name])),
    rules: room.rules,
    turnTimerSec: room.turnTimerSec,
    players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })),
  };
}

function broadcastGameState(room) {
  room.players.forEach(p => {
    const vista = engine.vistaParaJugador(room.game, p.id);
    io.to(p.id).emit('gameState', vista);
  });
}

async function nombreDePerfil(usuario, nombreRespaldo) {
  const perfil = await obtenerPerfil(usuario.id);
  return (perfil && perfil.display_name) || nombreRespaldo;
}

async function revisarFinDePartida(room) {
  if (!room.game || !room.game.ended || room.game.rewarded) return;
  room.game.rewarded = true;
  if (room.turnTimeoutHandle) { clearTimeout(room.turnTimeoutHandle); room.turnTimeoutHandle = null; }
  const maxScore = Math.max(...room.game.players.map(p => p.score || 0));
  for (const p of room.game.players) {
    if (!p.supabaseId) continue; // jugador invitado, sin cuenta: no hay monedas que dar
    const gano = (p.score || 0) === maxScore;
    const vagonesUsados = engine.PLAYER_TRAINS - p.trains;
    await premiarPartida(p.supabaseId, gano, p.score || 0, vagonesUsados);
  }
}

/* ---------- tiempo por turno (lo controla el servidor, no cada móvil) ---------- */
function scheduleTurnTimeout(room) {
  if (room.turnTimeoutHandle) { clearTimeout(room.turnTimeoutHandle); room.turnTimeoutHandle = null; }
  if (!room.turnTimerSec || room.turnTimerSec <= 0 || !room.game || room.game.ended) {
    if (room.game) room.game.turnDeadline = null;
    return;
  }
  room.game.turnDeadline = Date.now() + room.turnTimerSec * 1000;
  room.turnTimeoutHandle = setTimeout(() => forceTimeoutPlay(room), room.turnTimerSec * 1000);
}

async function forceTimeoutPlay(room) {
  if (!room.game || room.game.ended) return;
  const jugador = room.game.players[room.game.current];
  const antes = room.game.current;
  engine.accionRobarMazo(room.game, jugador.id);
  if (!room.game.ended && room.game.current === antes) engine.accionRobarMazo(room.game, jugador.id);
  await revisarFinDePartida(room);
  if (!room.game.ended) scheduleTurnTimeout(room);
  broadcastGameState(room);
}

io.on('connection', (socket) => {
  console.log('Nueva conexión:', socket.id);

  // --- registrar presencia (para saber qué amigos están conectados ahora) ---
  socket.on('authenticate', async ({ authToken }) => {
    const usuario = await verificarUsuario(authToken);
    if (usuario) { socket.data.supabaseId = usuario.id; onlineUsers[usuario.id] = socket.id; }
  });

  socket.on('checkFriendsOnline', ({ friendIds }) => {
    const online = (friendIds || []).filter(id => !!onlineUsers[id]);
    socket.emit('friendsOnline', { online });
  });

  socket.on('inviteFriend', ({ friendId, code, fromName }) => {
    const targetSocketId = onlineUsers[friendId];
    if (!targetSocketId) { socket.emit('errorMsg', 'Ese amigo no está conectado ahora mismo'); return; }
    io.to(targetSocketId).emit('roomInvite', { code, fromName });
  });

  // --- crear una sala nueva ---
  socket.on('createRoom', async ({ name, authToken, rules, turnTimerSec }) => {
    const usuario = await verificarUsuario(authToken);
    const code = generarCodigo();
    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: (usuario ? await nombreDePerfil(usuario, name) : name) || 'Jugador', supabaseId: usuario ? usuario.id : null }],
      started: false,
      mapKey: 'medi',
      rules: rules || { sabotage: false, demolition: false, stations: false, cooldown: false },
      turnTimerSec: turnTimerSec || 0,
      timerStarted: false,
      turnTimeoutHandle: null,
    };
    room.players[0].name = room.players[0].name.slice(0, 20);
    rooms[code] = room;
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('roomJoined', resumenSala(room));
  });

  // --- el anfitrión cambia las reglas opcionales antes de empezar ---
  socket.on('setRules', ({ rules }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.started) return;
    room.rules = rules || room.rules;
    io.to(code).emit('roomJoined', resumenSala(room));
  });

  // --- el anfitrión cambia el tiempo por turno antes de empezar ---
  socket.on('setTurnTimer', ({ turnTimerSec }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.started) return;
    room.turnTimerSec = turnTimerSec || 0;
    io.to(code).emit('roomJoined', resumenSala(room));
  });

  // --- el anfitrión cambia el mapa antes de empezar ---
  socket.on('setMap', ({ mapKey }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.started) return;
    if (!engine.MAPS_DATA[mapKey]) return;
    room.mapKey = mapKey;
    io.to(code).emit('roomJoined', resumenSala(room));
  });

  // --- unirse a una sala existente ---
  socket.on('joinRoom', async ({ code, name, authToken }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) { socket.emit('errorMsg', 'No existe ninguna sala con ese código'); return; }
    if (room.started) { socket.emit('errorMsg', 'Esa partida ya ha empezado'); return; }
    if (room.players.length >= 4) { socket.emit('errorMsg', 'La sala ya está llena (máximo 4)'); return; }

    const usuario = await verificarUsuario(authToken);
    const nombreFinal = ((usuario ? await nombreDePerfil(usuario, name) : name) || 'Jugador').slice(0, 20);
    room.players.push({ id: socket.id, name: nombreFinal, supabaseId: usuario ? usuario.id : null });
    socket.join(code);
    socket.data.roomCode = code;

    // avisamos a todos los de la sala (incluido el que se acaba de unir) del estado actualizado
    io.to(code).emit('roomJoined', resumenSala(room));
  });

  // --- salir de la sala a propósito ---
  socket.on('leaveRoom', () => salirDeSala(socket));

  // --- el anfitrión pulsa "Empezar partida" ---
  socket.on('startGame', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('errorMsg', 'Solo el anfitrión puede empezar la partida'); return; }
    if (room.players.length < 2) { socket.emit('errorMsg', 'Hacen falta al menos 2 jugadores'); return; }

    room.started = true;
    room.game = engine.crearPartida(room.mapKey, room.players, room.rules);
    io.to(code).emit('gameStarted', {});
    broadcastGameState(room);
  });

  // --- acciones dentro de la partida ---
  async function conRoomYPartida(socket, fn) {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.game) { socket.emit('errorMsg', 'No hay ninguna partida en marcha'); return; }
    const antes = room.game.current;
    const resultado = fn(room);
    if (resultado && resultado.ok === false) {
      socket.emit('errorMsg', resultado.error);
      return;
    }
    await revisarFinDePartida(room);
    if (!room.game.ended) {
      const siguenBilletesIniciales = engine.hayEleccionInicialPendiente(room.game);
      if (!siguenBilletesIniciales && (!room.timerStarted || room.game.current !== antes)) {
        room.timerStarted = true;
        scheduleTurnTimeout(room);
      }
    }
    broadcastGameState(room);
  }

  socket.on('drawFaceUp', ({ idx }) => {
    conRoomYPartida(socket, room => engine.accionRobarVisible(room.game, socket.id, idx));
  });
  socket.on('drawBlind', () => {
    conRoomYPartida(socket, room => engine.accionRobarMazo(room.game, socket.id));
  });
  socket.on('selectRoute', ({ routeId, color }) => {
    conRoomYPartida(socket, room => engine.accionSeleccionarVia(room.game, socket.id, routeId, color));
  });
  socket.on('requestTickets', () => {
    conRoomYPartida(socket, room => engine.accionPedirBilletes(room.game, socket.id));
  });
  socket.on('confirmTickets', ({ indices }) => {
    conRoomYPartida(socket, room => engine.accionConfirmarBilletes(room.game, socket.id, indices));
  });
  socket.on('playSabotage', ({ routeId }) => {
    conRoomYPartida(socket, room => engine.accionSabotaje(room.game, socket.id, routeId));
  });
  socket.on('playDemolition', ({ routeId }) => {
    conRoomYPartida(socket, room => engine.accionDemolicion(room.game, socket.id, routeId));
  });
  socket.on('playStation', ({ cityId }) => {
    conRoomYPartida(socket, room => engine.accionEstacion(room.game, socket.id, cityId));
  });

  // --- se cierra la pestaña / se pierde la conexión ---
  socket.on('disconnect', () => {
    if (socket.data.supabaseId && onlineUsers[socket.data.supabaseId] === socket.id) {
      delete onlineUsers[socket.data.supabaseId];
    }
    salirDeSala(socket);
  });

  function salirDeSala(socket) {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(code);
    socket.data.roomCode = null;

    if (room.players.length === 0) {
      if (room.turnTimeoutHandle) clearTimeout(room.turnTimeoutHandle);
      delete rooms[code]; // sala vacía, la borramos
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id; // el anfitrión se fue: pasa el testigo al siguiente
    }
    io.to(code).emit('roomJoined', resumenSala(room));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Servidor de Tren Expreso escuchando en el puerto ' + PORT);
});
