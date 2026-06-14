// ════════════════════════════════════════════════════════════════
//  Crédito San Juan — Revisión diaria de vencimientos + push
//  Corre desde GitHub Actions (servidor). NO depende de que la app
//  esté abierta. Node 18+ (fetch nativo).
// ════════════════════════════════════════════════════════════════

const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_KEY;        // anon key (la misma del HTML)
const ONESIGNAL_APP_ID   = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY;  // ¡SECRETA! solo en GitHub Secrets

const TZ = 'America/Lima'; // Perú UTC-5

// Verificar que las variables existan (evita fallos silenciosos)
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_KEY, ONESIGNAL_APP_ID, ONESIGNAL_REST_KEY })) {
  if (!v) { console.error(`❌ Falta la variable de entorno ${k}`); process.exit(1); }
}

const N = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

// Fecha de HOY en hora de Perú, formato YYYY-MM-DD (igual que en Supabase)
function hoyLima() {
  // 'en-CA' devuelve el formato YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function sendPush(heading, content) {
  const r = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Llaves nuevas (os_v2_app_...) usan el prefijo "Key", NO "Basic"
      Authorization: `Key ${ONESIGNAL_REST_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      target_channel: 'push',
      included_segments: ['Subscribed Users'],
      headings: { en: heading, es: heading },
      contents: { en: content, es: content },
    }),
  });
  const txt = await r.text();
  console.log(`OneSignal → ${r.status}: ${txt}`);
  // Si OneSignal no devuelve "id", no había dispositivos suscritos
  try { if (!JSON.parse(txt).id) console.warn('⚠ Sin suscriptores válidos. ¿Algún dispositivo activó las alertas?'); }
  catch (e) {}
  if (!r.ok) process.exitCode = 1;
}

(async () => {
  const hoy = hoyLima();
  console.log(`📅 Revisando vencimientos para hoy: ${hoy} (${TZ})`);

  const [prestamos, cronograma] = await Promise.all([
    sb('prestamos?select=*'),
    sb('cronograma?select=*'),
  ]);

  // Préstamos cancelados: alguna cuota "CANCELAR" con pago real
  const cancelados = {};
  for (const c of cronograma) {
    const tp = (c.tipo_pago || '').toUpperCase();
    if (tp.includes('CANCELAR') && N(c.monto_pagado) > 0) cancelados[c.prestamo_id] = true;
  }

  const clienteDe = id => (prestamos.find(p => Number(p.id) === Number(id)) || {}).cliente || '';

  // Misma lógica de "cuota cobrable" que la app (checkAndFireAlerts):
  // se excluyen pagadas, adelantadas, parciales, préstamos cancelados.
  const cobrable = c => {
    if (cancelados[c.prestamo_id]) return false;
    const tp = (c.tipo_pago || '').toUpperCase().trim();
    if (tp === 'PAGO ADELANTADO') return false;
    if (tp.includes('CANCELAR')) return false;
    if (tp === 'SOLO INTERES') return N(c.capital_cuota) > 0 && c.fecha_vence < hoy;
    // NORMAL: solo cuenta si NO tiene ningún pago (pendiente o vencida)
    return N(c.monto_pagado) <= 0;
  };

  const saldo = c => {
    const tp = (c.tipo_pago || '').toUpperCase().trim();
    if (tp === 'SOLO INTERES') return N(c.capital_cuota);
    const pagado = N(c.monto_pagado);
    return pagado ? Math.max(0, N(c.cuota_base) - pagado) : N(c.cuota_base);
  };

  const fmt = v => 'S/ ' + Math.ceil(v).toLocaleString('es-PE');
  const nombres = (list, n = 3) =>
    [...new Set(list.map(c => clienteDe(c.prestamo_id) || c.cliente))].slice(0, n);

  const pend     = cronograma.filter(cobrable);
  const venceHoy = pend.filter(c => c.fecha_vence === hoy);
  const vencidas = pend.filter(c => c.fecha_vence < hoy);

  console.log(`   Vencen HOY: ${venceHoy.length} | En mora: ${vencidas.length}`);

  // Cuotas que vencen HOY (lo que pediste: alerta solo el mismo día)
  if (venceHoy.length > 0) {
    const monto = venceHoy.reduce((a, c) => a + saldo(c), 0);
    const ns = nombres(venceHoy);
    const extra = venceHoy.length > ns.length ? ` y ${venceHoy.length - ns.length} más` : '';
    const plural = venceHoy.length > 1;
    await sendPush(
      `🔴 ${venceHoy.length} cuota${plural ? 's' : ''} vence${plural ? 'n' : ''} HOY`,
      `${ns.join(', ')}${extra} · ${fmt(monto)}`,
    );
  } else {
    console.log('✅ Nada vence hoy.');
  }
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
