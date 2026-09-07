/* ============================================================
   TREN EXPRESO — MOTOR DE JUEGO (versión servidor)
   ============================================================
   Esto es el mismo motor de reglas que ya teníamos en el juego
   del móvil, pero adaptado para correr aquí en el servidor:
     - No dibuja nada en pantalla (eso lo sigue haciendo el móvil)
     - No confía en lo que diga el móvil: decide él solo quién
       gana una carta al robar, valida que de verdad tengas las
       cartas que dices tener antes de dejarte reclamar una vía, etc.
     - Cada función devuelve { ok:true/false, error, state } en
       vez de tocar directamente la pantalla.

   De momento cubre el núcleo de una partida: robar cartas,
   reclamar vías, robar y confirmar billetes de destino, turnos,
   última ronda y puntuación final.
   No incluye todavía las mecánicas opcionales (sabotaje,
   demolición, estaciones, enfriamiento) — eso vendrá después.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const MAPS_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'mapsData.json'), 'utf-8'));

const COLORS = ['purple', 'white', 'blue', 'yellow', 'orange', 'black', 'red', 'green'];
const POINTS_BY_LEN = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 10, 6: 13, 7: 17, 8: 21 };
const PLAYER_TRAINS = 40;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- construir el mapa activo a partir de los datos puros ---------- */
function construirMapa(mapKey) {
  const raw = MAPS_DATA[mapKey] || MAPS_DATA.medi;
  const cities = raw.cities;
  const cityIds = new Set(cities.map(c => c.id));
  let routes = raw.routes.map((r, i) => ({ id: 'r' + i, a: r.a, b: r.b, len: r.len, color: r.color }));
  (raw.duals || []).forEach(({ a, b, color }) => {
    const orig = routes.find(r => (r.a === a && r.b === b) || (r.a === b && r.b === a));
    if (!orig) return;
    const dualKey = a + '-' + b;
    const seed = parseInt(orig.id.slice(1), 10);
    orig.dual = dualKey; orig.dualSide = 1; orig.pairSeed = seed;
    routes.push({ id: 'r' + routes.length, a: orig.a, b: orig.b, len: orig.len, color, dual: dualKey, dualSide: -1, pairSeed: seed });
  });
  const tickets = raw.tickets.map((t, i) => ({ id: 't' + i, a: t.a, b: t.b, pts: t.pts }));
  return { cityIds, routes, tickets };
}

/* ---------- unión-búsqueda para calcular conectividad (billetes) ---------- */
function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  return { find, union };
}

function longestTrail(edges) {
  // misma lógica que en el cliente: DFS con backtracking sobre las vías del jugador
  const adj = {};
  edges.forEach(([a, b, id]) => {
    (adj[a] = adj[a] || []).push([b, id]);
    (adj[b] = adj[b] || []).push([a, id]);
  });
  let best = 0;
  function dfs(node, usedIds, len) {
    best = Math.max(best, len);
    (adj[node] || []).forEach(([next, id]) => {
      if (!usedIds.has(id)) {
        usedIds.add(id);
        dfs(next, usedIds, len + 1);
        usedIds.delete(id);
      }
    });
  }
  Object.keys(adj).forEach(node => dfs(node, new Set(), 0));
  return best;
}

/* ---------- crear una partida nueva a partir de los jugadores de una sala ---------- */
function crearPartida(mapKey, players, rules) {
  rules = rules || { sabotage:false, demolition:false, stations:false, cooldown:false };
  const mapa = construirMapa(mapKey);
  let deck = [];
  COLORS.forEach(c => { for (let i = 0; i < 12; i++) deck.push(c); });
  for (let i = 0; i < 14; i++) deck.push('locomotora');
  if (rules.sabotage) for (let i = 0; i < 3; i++) deck.push('sabotaje');
  if (rules.demolition) for (let i = 0; i < 3; i++) deck.push('demolicion');
  deck = shuffle(deck);

  const gamePlayers = players.map((p, i) => ({
    id: p.id, name: p.name, color: i,
    trains: PLAYER_TRAINS, hand: {}, routes: [], tickets: [], score: 0,
    stations: rules.stations ? 3 : 0, stationCities: [], skipNextBuild: false,
  }));

  const faceUp = [];
  for (let i = 0; i < 5; i++) faceUp.push(deck.pop());

  const state = {
    mapKey, routes: mapa.routes, tickets: mapa.tickets,
    players: gamePlayers, deck, discard: [], faceUp, ticketDeck: shuffle(mapa.tickets),
    current: 0, drawsUsed: 0, claim: null,
    lastRound: false, lastRoundStarter: null, ended: false,
    log: [], rules,
    pendingTickets: {}, // playerId -> { opciones, minKeep, isInitial }
  };

  gamePlayers.forEach(p => {
    for (let k = 0; k < 4; k++) {
      const c = drawFromDeck(state);
      if (c) p.hand[c] = (p.hand[c] || 0) + 1;
    }
    state.pendingTickets[p.id] = { opciones: state.ticketDeck.splice(0, 3), minKeep: 2, isInitial: true };
  });

  addLog(state, 'La partida comienza. Se reparten billetes de destino iniciales.');
  return state;
}

function addLog(state, msg) {
  state.log.unshift(msg);
  if (state.log.length > 60) state.log.length = 60;
}

function drawFromDeck(state) {
  if (state.deck.length === 0) {
    if (state.discard.length === 0) return null;
    state.deck = shuffle(state.discard);
    state.discard = [];
  }
  return state.deck.pop();
}

function refillFaceUp(state) {
  while (state.faceUp.length < 5 && (state.deck.length > 0 || state.discard.length > 0)) {
    const c = drawFromDeck(state);
    if (c == null) break;
    state.faceUp.push(c);
  }
}

function curPlayer(state) { return state.players[state.current]; }
function routeById(state, id) { return state.routes.find(r => r.id === id); }
function routeOwner(state, routeId) { return state.players.find(p => p.routes.includes(routeId)) || null; }

function dualBloqueada(state, route, player) {
  if (!route.dual) return false;
  return player.routes.some(rid => {
    const rr = routeById(state, rid);
    return rr && rr.id !== route.id && rr.dual === route.dual;
  });
}

function coloresValidosPara(state, route, player) {
  if (dualBloqueada(state, route, player)) return [];
  const opciones = [];
  if (route.color === 'gray') {
    COLORS.forEach(c => {
      const tengo = player.hand[c] || 0;
      const locos = player.hand['locomotora'] || 0;
      if (tengo + locos >= route.len && tengo > 0) opciones.push(c);
    });
    if (opciones.length === 0 && (player.hand['locomotora'] || 0) >= route.len) opciones.push('locomotora');
  } else {
    const tengo = player.hand[route.color] || 0;
    const locos = player.hand['locomotora'] || 0;
    if (tengo + locos >= route.len) opciones.push(route.color);
  }
  return opciones.filter(c => (player.trains >= route.len));
}

/* ============================================================
   ACCIONES — cada una valida todo antes de tocar el estado.
   Devuelven { ok, error } y modifican `state` si todo es correcto.
   ============================================================ */

function hayEleccionInicialPendiente(state) {
  return Object.values(state.pendingTickets).some(pt => pt.isInitial);
}

function accionRobarVisible(state, playerId, idx) {
  if (hayEleccionInicialPendiente(state)) return { ok: false, error: 'Esperando a que todos elijan sus billetes iniciales' };
  const p = curPlayer(state);
  if (p.id !== playerId) return { ok: false, error: 'No es tu turno' };
  if (state.claim) return { ok: false, error: 'Tienes una vía pendiente de confirmar' };
  const card = state.faceUp[idx];
  if (card == null) return { ok: false, error: 'Esa carta ya no está ahí' };
  const esLoco = card === 'locomotora';
  if (esLoco && state.drawsUsed >= 1) return { ok: false, error: 'No puedes robar una locomotora visible como segunda carta' };

  p.hand[card] = (p.hand[card] || 0) + 1;
  state.faceUp.splice(idx, 1);
  refillFaceUp(state);
  state.drawsUsed++;
  addLog(state, `${p.name} roba una carta visible.`);
  if (esLoco || state.drawsUsed >= 2) finalizarTurno(state);
  return { ok: true };
}

function accionRobarMazo(state, playerId) {
  if (hayEleccionInicialPendiente(state)) return { ok: false, error: 'Esperando a que todos elijan sus billetes iniciales' };
  const p = curPlayer(state);
  if (p.id !== playerId) return { ok: false, error: 'No es tu turno' };
  if (state.claim) return { ok: false, error: 'Tienes una vía pendiente de confirmar' };
  const card = drawFromDeck(state);
  if (card == null) return { ok: false, error: 'No quedan cartas en el mazo' };
  p.hand[card] = (p.hand[card] || 0) + 1;
  state.drawsUsed++;
  addLog(state, `${p.name} roba una carta del mazo.`);
  if (state.drawsUsed >= 2) finalizarTurno(state);
  return { ok: true };
}

function accionSeleccionarVia(state, playerId, routeId, colorElegido) {
  if (hayEleccionInicialPendiente(state)) return { ok: false, error: 'Esperando a que todos elijan sus billetes iniciales' };
  const p = curPlayer(state);
  if (p.id !== playerId) return { ok: false, error: 'No es tu turno' };
  if (state.rules.cooldown && p.skipNextBuild === 'active') return { ok: false, error: 'Acabas de construir: este turno solo puedes robar o pedir billetes' };
  const route = routeById(state, routeId);
  if (!route) return { ok: false, error: 'Vía inexistente' };
  if (routeOwner(state, routeId)) return { ok: false, error: 'Esa vía ya está ocupada' };
  if (state.drawsUsed > 0) return { ok: false, error: 'Ya has robado cartas este turno' };
  const opciones = coloresValidosPara(state, route, p);
  if (!opciones.includes(colorElegido)) return { ok: false, error: 'No tienes cartas suficientes de ese color' };

  const need = route.len;
  const tengo = p.hand[colorElegido] || 0;
  const useColor = Math.min(tengo, need);
  const useLoco = need - useColor;
  p.hand[colorElegido] -= useColor;
  p.hand['locomotora'] = (p.hand['locomotora'] || 0) - useLoco;
  for (let i = 0; i < useColor; i++) state.discard.push(colorElegido);
  for (let i = 0; i < useLoco; i++) state.discard.push('locomotora');
  p.trains -= route.len;
  p.routes.push(route.id);
  if (state.rules.cooldown) p.skipNextBuild = 'pending';
  addLog(state, `${p.name} reclama una vía (${route.len} vagones).`);

  if (p.trains <= 2 && !state.lastRound) {
    state.lastRound = true;
    state.lastRoundStarter = state.current;
    addLog(state, `${p.name} tiene ${p.trains} vagones o menos: ¡última ronda!`);
  }
  finalizarTurno(state);
  return { ok: true };
}

function accionPedirBilletes(state, playerId) {
  if (hayEleccionInicialPendiente(state)) return { ok: false, error: 'Esperando a que todos elijan sus billetes iniciales' };
  const p = curPlayer(state);
  if (p.id !== playerId) return { ok: false, error: 'No es tu turno' };
  if (state.claim || state.drawsUsed > 0) return { ok: false, error: 'No puedes pedir billetes ahora' };
  if (state.pendingTickets[playerId]) return { ok: false, error: 'Ya tienes billetes pendientes de elegir' };
  if (state.ticketDeck.length === 0) return { ok: false, error: 'No quedan billetes' };
  const opciones = state.ticketDeck.splice(0, 3);
  state.pendingTickets[playerId] = { opciones, minKeep: 1, isInitial: false };
  return { ok: true, opciones };
}

function accionConfirmarBilletes(state, playerId, indicesElegidos) {
  const pend = state.pendingTickets[playerId];
  if (!pend) return { ok: false, error: 'No tienes una elección de billetes pendiente' };
  if (indicesElegidos.length < pend.minKeep) return { ok: false, error: `Debes quedarte al menos ${pend.minKeep}` };
  const p = state.players.find(pl => pl.id === playerId);
  const elegidos = indicesElegidos.map(i => pend.opciones[i]);
  const devueltos = pend.opciones.filter((_, i) => !indicesElegidos.includes(i));
  p.tickets.push(...elegidos);
  state.ticketDeck.push(...shuffle(devueltos));
  addLog(state, `${p.name} se queda con ${elegidos.length} billete(s) de destino.`);
  const eraInicial = pend.isInitial;
  delete state.pendingTickets[playerId];
  if (!eraInicial && p.id === curPlayer(state).id) finalizarTurno(state);
  return { ok: true };
}

/* ---- choque de trenes ---- */
function accionSabotaje(state, playerId, routeId) {
  if (hayEleccionInicialPendiente(state)) return { ok: false, error: 'Esperando a que todos elijan sus billetes iniciales' };
  const p = curPlayer(state);
  if (p.id !== playerId) return { ok: false, error: 'No es tu turno' };
  if (state.drawsUsed > 0) return { ok: false, error: 'No puedes hacer eso ahora' };
  if (!p.hand['sabotaje']) return { ok: false, error: 'No tienes cartas de Choque de Trenes' };
  const route = routeById(state, routeId);
  if (!route) return { ok: false, error: 'Vía inexistente' };
  const defender = routeOwner(state, routeId);
  if (!defender || defender.id === playerId) return { ok: false, error: 'Elige una vía de un rival' };

  p.hand['sabotaje']--; if (p.hand['sabotaje'] <= 0) delete p.hand['sabotaje'];
  const attackerSize = Object.values(p.hand).reduce((a, b) => a + b, 0);
  const defenderSize = Object.values(defender.hand).reduce((a, b) => a + b, 0);
  const win = attackerSize > defenderSize;

  [p, defender].forEach(player => {
    Object.keys(player.hand).forEach(c => { for (let i = 0; i < player.hand[c]; i++) state.discard.push(c); });
    player.hand = {};
  });

  if (win) {
    defender.routes = defender.routes.filter(id => id !== route.id);
    defender.trains += route.len;
    p.routes.push(route.id);
    addLog(state, `${p.name} choca ${attackerSize} cartas contra las ${defenderSize} de ${defender.name} y se queda con su vía. Ambos pierden la mano.`);
  } else {
    addLog(state, `${p.name} choca ${attackerSize} cartas contra las ${defenderSize} de ${defender.name} y pierde: conserva su vía. Ambos pierden la mano.`);
  }
  finalizarTurno(state);
  return { ok: true, gano: win };
}

/* ---- demolición ---- */
function accionDemolicion(state, playerId, routeId) {
  if (hayEleccionInicialPendiente(state)) return { ok: false, error: 'Esperando a que todos elijan sus billetes iniciales' };
  const p = curPlayer(state);
  if (p.id !== playerId) return { ok: false, error: 'No es tu turno' };
  if (state.drawsUsed > 0) return { ok: false, error: 'No puedes hacer eso ahora' };
  if (!p.hand['demolicion']) return { ok: false, error: 'No tienes cartas de Demolición' };
  const route = routeById(state, routeId);
  if (!route) return { ok: false, error: 'Vía inexistente' };
  const defender = routeOwner(state, routeId);
  if (!defender || defender.id === playerId) return { ok: false, error: 'Elige una vía de un rival' };

  p.hand['demolicion']--; if (p.hand['demolicion'] <= 0) delete p.hand['demolicion'];
  defender.routes = defender.routes.filter(id => id !== route.id);
  defender.trains += route.len;
  addLog(state, `${p.name} demuele la vía de ${defender.name}. Le devuelve sus vagones y la vía queda libre.`);
  finalizarTurno(state);
  return { ok: true };
}

/* ---- estaciones ---- */
function accionEstacion(state, playerId, cityId) {
  if (hayEleccionInicialPendiente(state)) return { ok: false, error: 'Esperando a que todos elijan sus billetes iniciales' };
  const p = curPlayer(state);
  if (p.id !== playerId) return { ok: false, error: 'No es tu turno' };
  if (state.drawsUsed > 0) return { ok: false, error: 'No puedes hacer eso ahora' };
  if (!state.rules.stations) return { ok: false, error: 'Las estaciones no están activadas en esta partida' };
  if ((p.stations || 0) <= 0) return { ok: false, error: 'No te quedan estaciones' };
  if (!p.hand['locomotora']) return { ok: false, error: 'Necesitas una carta locomotora' };
  if ((p.stationCities || []).includes(cityId)) return { ok: false, error: 'Ya tienes una estación ahí' };

  p.hand['locomotora']--; if (p.hand['locomotora'] <= 0) delete p.hand['locomotora'];
  p.stations--;
  if (!p.stationCities) p.stationCities = [];
  p.stationCities.push(cityId);
  addLog(state, `${p.name} construye una estación.`);
  finalizarTurno(state);
  return { ok: true };
}

function finalizarTurno(state) {
  state.drawsUsed = 0;
  state.claim = null;
  if (state.rules && state.rules.cooldown) {
    const cp = curPlayer(state);
    if (cp.skipNextBuild === 'active') cp.skipNextBuild = false;
    else if (cp.skipNextBuild === 'pending') cp.skipNextBuild = 'active';
  }
  if (state.lastRound && state.current === state.lastRoundStarter && state._loopStarted) {
    finalizarPartida(state);
    return;
  }
  if (state.lastRound) state._loopStarted = true;
  state.current = (state.current + 1) % state.players.length;
}

function calcularPuntuaciones(state) {
  const idxOf = {};
  const allCityIds = Array.from(new Set(state.routes.flatMap(r => [r.a, r.b])));
  allCityIds.forEach((id, i) => { idxOf[id] = i; });

  state.players.forEach(p => {
    let score = 0;
    p.routes.forEach(rid => { const r = routeById(state, rid); score += POINTS_BY_LEN[r.len] || 0; });
    p.routePoints = score;
    const uf = unionFind(allCityIds.length);
    p.routes.forEach(rid => { const r = routeById(state, rid); uf.union(idxOf[r.a], idxOf[r.b]); });
    (p.stationCities || []).forEach(cityId => {
      state.routes.forEach(r => {
        if ((r.a === cityId || r.b === cityId) && routeOwner(state, r.id)) uf.union(idxOf[r.a], idxOf[r.b]);
      });
    });
    p.ticketResults = p.tickets.map(t => {
      const connected = uf.find(idxOf[t.a]) === uf.find(idxOf[t.b]);
      score += connected ? t.pts : -t.pts;
      return { ...t, connected };
    });
    const edges = p.routes.map(rid => { const r = routeById(state, rid); return [r.a, r.b, rid]; });
    p.longest = longestTrail(edges);
    p.score = score;
  });
  const maxLen = Math.max(...state.players.map(p => p.longest));
  state.players.forEach(p => {
    p.longestBonus = (p.longest === maxLen && maxLen > 0);
    if (p.longestBonus) p.score += 10;
  });
}

function finalizarPartida(state) {
  state.ended = true;
  calcularPuntuaciones(state);
}

/* ---------- qué le mandamos a cada jugador (oculta las manos ajenas) ---------- */
function vistaParaJugador(state, playerId) {
  if (!state.ended) calcularPuntuaciones(state); // puntuación siempre al día, no solo al terminar
  return {
    mapKey: state.mapKey,
    rules: state.rules,
    turnDeadline: state.turnDeadline || null,
    current: state.players[state.current].id,
    drawsUsed: state.drawsUsed,
    lastRound: state.lastRound,
    ended: state.ended,
    faceUp: state.faceUp,
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    ticketDeckCount: state.ticketDeck.length,
    log: state.log.slice(0, 20),
    pendingTickets: state.pendingTickets[playerId] || null,
    players: state.players.map(p => ({
      id: p.id, name: p.name, color: p.color, trains: p.trains,
      routes: p.routes, score: p.score, routePoints: p.routePoints,
      longest: p.longest, longestBonus: p.longestBonus,
      handCount: Object.values(p.hand).reduce((a, b) => a + b, 0),
      ticketCount: p.tickets.length,
      stations: p.stations, stationCities: p.stationCities,
      skipNextBuild: p.skipNextBuild,
      // la mano de cartas sí sigue siendo privada; los billetes de destino ya no son secretos —
      // se ven completos de todos, en todo momento, con quién está conectado y quién no
      hand: (p.id === playerId || state.ended) ? p.hand : undefined,
      tickets: (p.id === playerId || state.ended) ? p.tickets : undefined,
      ticketResults: (p.id === playerId || state.ended) ? p.ticketResults : undefined,
    })),
  };
}

module.exports = {
  MAPS_DATA, PLAYER_TRAINS, crearPartida, vistaParaJugador,
  accionRobarVisible, accionRobarMazo, accionSeleccionarVia,
  accionPedirBilletes, accionConfirmarBilletes,
  accionSabotaje, accionDemolicion, accionEstacion,
  hayEleccionInicialPendiente,
};
       
