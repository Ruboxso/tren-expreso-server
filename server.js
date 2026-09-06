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
    players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })),
  };
}

function broadcastGameState(room) {
  room.players.forEach(p => {
    const vista = engine.vistaParaJugador(room.game, p.id);
    io.to(p.id).emit('gameState', vista);
  });
}

io.on('connection', (socket) => {
  console.log('Nueva conexión:', socket.id);

  // --- crear una sala nueva ---
  socket.on('createRoom', ({ name }) => {
    const code = generarCodigo();
    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: (name || 'Jugador').slice(0, 20) }],
      started: false,
      mapKey: 'medi',
    };
    rooms[code] = room;
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('roomJoined', resumenSala(room));
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
  socket.on('joinRoom', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) { socket.emit('errorMsg', 'No existe ninguna sala con ese código'); return; }
    if (room.started) { socket.emit('errorMsg', 'Esa partida ya ha empezado'); return; }
    if (room.players.length >= 4) { socket.emit('errorMsg', 'La sala ya está llena (máximo 4)'); return; }

    room.players.push({ id: socket.id, name: (name || 'Jugador').slice(0, 20) });
    socket.join(code);
    socket.data.roomCode = code;

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
    room.game = engine.crearPartida(room.mapKey, room.players);
    io.to(code).emit('gameStarted', {});
    broadcastGameState(room);
  });

  // --- acciones dentro de la partida ---
  function conRoomYPartida(socket, fn) {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.game) { socket.emit('errorMsg', 'No hay ninguna partida en marcha'); return; }
    const resultado = fn(room);
    if (resultado && resultado.ok === false) {
      socket.emit('errorMsg', resultado.error);
      return;
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

  // --- se cierra la pestaña / se pierde la conexión ---
  socket.on('disconnect', () => salirDeSala(socket));

  function salirDeSala(socket) {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(code);
    socket.data.roomCode = null;

    if (room.players.length === 0) {
      delete rooms[code];
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
    }
    io.to(code).emit('roomJoined', resumenSala(room));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Servidor de Tren Expreso escuchando en el puerto ' + PORT);
});
