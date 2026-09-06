/* ============================================================
   CONEXIÓN A SUPABASE (lado servidor)
   ============================================================
   Usa la clave SECRETA (sb_secret_...), que puede leer y escribir
   cualquier perfil sin restricciones — por eso solo puede vivir
   aquí, en el servidor, y nunca en el archivo del juego ni en
   GitHub.

   Las dos variables de entorno (SUPABASE_URL y SUPABASE_SECRET_KEY)
   se configuran en Render → Settings → Environment, NO en el
   código. Si no están puestas, este archivo avisa por consola y
   el resto del servidor sigue funcionando igual, simplemente sin
   guardar monedas ni estadísticas.
   ============================================================ */

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

let supabaseAdmin = null;
if (url && secretKey) {
  supabaseAdmin = createClient(url, secretKey);
  console.log('Supabase conectado.');
} else {
  console.warn('Aviso: faltan SUPABASE_URL o SUPABASE_SECRET_KEY — las cuentas y monedas no funcionarán hasta que se configuren en Render.');
}

/* ---- comprobar el "carnet" (token) que manda el jugador y decir quién es ---- */
async function verificarUsuario(token) {
  if (!supabaseAdmin || !token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user; // tiene .id, .email, etc.
  } catch (e) {
    return null;
  }
}

/* ---- leer el perfil (nombre, monedas...) de un usuario ---- */
async function obtenerPerfil(userId) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).single();
  if (error) return null;
  return data;
}

/* ---- premiar a un jugador al terminar una partida online ---- */
async function premiarPartida(userId, gano, puntos, vagonesUsados) {
  if (!supabaseAdmin) return;
  const perfil = await obtenerPerfil(userId);
  if (!perfil) return;
  const nuevasMonedas = perfil.coins + 1 + (gano ? 3 : 0);
  await supabaseAdmin.from('profiles').update({
    coins: nuevasMonedas,
    games_played: perfil.games_played + 1,
    games_won: perfil.games_won + (gano ? 1 : 0),
    total_points: perfil.total_points + (puntos || 0),
    total_trains_used: perfil.total_trains_used + (vagonesUsados || 0),
  }).eq('id', userId);
}

module.exports = { verificarUsuario, obtenerPerfil, premiarPartida };

