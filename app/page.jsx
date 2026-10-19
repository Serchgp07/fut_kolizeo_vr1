'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

/* ============================================================
   CONSTANTES Y REGLAS DE LA LIGA (ajustables)
   ============================================================ */
const TURNOS = ['Matutino', 'Vespertino'];
const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const YELLOW_LIMIT = 3; // amarillas acumuladas que generan 1 partido de suspensión
const POINTS_WIN = 3;
const POINTS_DRAW = 1;

const LS_STATE = 'liga_pro_state_v1';
const LS_CFG = 'liga_pro_supabase_v1';
const LS_SEL = 'liga_pro_sel_v1';
const TABLE = 'liga_state';
const ROW_ID = 'principal';

const CARD_LABEL = {
  yellow: 'Amarilla',
  double_yellow: 'Doble amarilla (expulsión)',
  red: 'Roja directa',
};

const SQL_SETUP = `create table if not exists public.liga_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.liga_state enable row level security;

create policy "liga_acceso_publico"
  on public.liga_state
  for all
  using (true)
  with check (true);

-- Sincronización en tiempo real entre dispositivos
alter publication supabase_realtime add table public.liga_state;`;

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const CLIENT_ID = uid();
const emptyLeague = () => ({ teams: [], players: [], matches: [] });
const leagueKey = (t, d) => `${t}|${d}`;
const TEAM_COLORS = ['#00e676', '#2979ff', '#ff3b4e', '#ffc83d', '#b388ff', '#ff9100', '#18ffff', '#f50057'];

/* ============================================================
   LÓGICA: TABLA GENERAL
   ============================================================ */
function computeStandings(league) {
  const rows = Object.fromEntries(
    league.teams.map((t) => [
      t.id,
      { team: t, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, dg: 0, pts: 0, form: [] },
    ])
  );
  [...league.matches]
    .filter((m) => m.played)
    .sort((a, b) => a.round - b.round || a.created - b.created)
    .forEach((m) => {
      const h = rows[m.homeId];
      const a = rows[m.awayId];
      if (!h || !a) return;
      h.pj++; a.pj++;
      h.gf += m.homeGoals; h.gc += m.awayGoals;
      a.gf += m.awayGoals; a.gc += m.homeGoals;
      if (m.homeGoals > m.awayGoals) {
        h.pg++; a.pp++; h.pts += POINTS_WIN; h.form.push('G'); a.form.push('P');
      } else if (m.homeGoals < m.awayGoals) {
        a.pg++; h.pp++; a.pts += POINTS_WIN; a.form.push('G'); h.form.push('P');
      } else {
        h.pe++; a.pe++; h.pts += POINTS_DRAW; a.pts += POINTS_DRAW; h.form.push('E'); a.form.push('E');
      }
    });
  return Object.values(rows)
    .map((r) => ({ ...r, dg: r.gf - r.gc }))
    .sort((x, y) => y.pts - x.pts || y.dg - x.dg || y.gf - x.gf || x.team.name.localeCompare(y.team.name));
}

/* ============================================================
   LÓGICA: DISCIPLINA Y SUSPENSIONES
   Reglas:
   - Roja directa            -> 1 partido de suspensión
   - Doble amarilla          -> 1 partido de suspensión
   - 3 amarillas acumuladas  -> 1 partido de suspensión (el contador se reinicia)
   La suspensión se cumple en el siguiente partido del equipo según el orden de jornadas.
   ============================================================ */
function computeDiscipline(league) {
  const { teams, matches } = league;
  const stats = {};
  const get = (id) => (stats[id] = stats[id] || { y: 0, dy: 0, r: 0, accum: 0 });
  const susForMatch = {};
  const tail = [];

  teams.forEach((team) => {
    const tm = matches
      .filter((m) => m.homeId === team.id || m.awayId === team.id)
      .sort((a, b) => a.round - b.round || a.created - b.created);
    let pending = [];
    tm.forEach((m) => {
      if (pending.length) susForMatch[m.id] = [...(susForMatch[m.id] || []), ...pending];
      const next = new Map();
      (m.cards || [])
        .filter((c) => c.teamId === team.id)
        .forEach((c) => {
          const s = get(c.playerId);
          if (c.type === 'yellow') {
            s.y++; s.accum++;
            if (s.accum >= YELLOW_LIMIT) {
              s.accum = 0;
              if (!next.has(c.playerId)) next.set(c.playerId, `Acumulación de ${YELLOW_LIMIT} amarillas`);
            }
          } else if (c.type === 'double_yellow') {
            s.dy++; next.set(c.playerId, 'Doble amarilla');
          } else if (c.type === 'red') {
            s.r++; next.set(c.playerId, 'Roja directa');
          }
        });
      pending = [...next].map(([playerId, reason]) => ({ playerId, teamId: team.id, reason }));
    });
    pending.forEach((p) => tail.push(p));
  });
  return { stats, susForMatch, tail };
}

/* ============================================================
   COMPONENTES UI BÁSICOS
   ============================================================ */
function CardChip({ type }) {
  if (type === 'double_yellow') {
    return (
      <span className="relative inline-block h-4 w-5 align-middle">
        <span className="absolute left-0 top-0 h-4 w-3 rounded-[2px] bg-card-yellow" />
        <span className="absolute left-1.5 top-0.5 h-4 w-3 rounded-[2px] bg-card-red ring-1 ring-night-900" />
      </span>
    );
  }
  return (
    <span
      className={`inline-block h-4 w-3 rounded-[2px] align-middle ${
        type === 'red' ? 'bg-card-red' : 'bg-card-yellow'
      }`}
    />
  );
}

function Empty({ title, text, children }) {
  return (
    <div className="panel flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-pitch/10 text-2xl text-pitch">⚽</div>
      <h3 className="font-display text-2xl font-bold uppercase tracking-wide">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-400">{text}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}

function SectionTitle({ title, subtitle, action }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-display text-3xl font-extrabold uppercase tracking-wide">{title}</h2>
        {subtitle && <p className="text-sm text-slate-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function StatusPill({ status, saving }) {
  const map = {
    local: ['Modo local', 'bg-slate-500/20 text-slate-300'],
    connecting: ['Conectando…', 'bg-amber-400/15 text-amber-300'],
    online: ['En línea · Supabase', 'bg-pitch/15 text-pitch'],
    error: ['Error de conexión', 'bg-red-500/15 text-red-400'],
  };
  const [label, cls] = map[status] || map.local;
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${cls}`}>
      <span className={`h-2 w-2 rounded-full bg-current ${saving ? 'animate-pulse' : ''}`} />
      {saving ? 'Guardando…' : label}
    </span>
  );
}

/* ============================================================
   VISTA: TABLA GENERAL
   ============================================================ */
function TablaView({ standings, league, goTo }) {
  if (!league.teams.length) {
    return (
      <Empty
        title="Aún no hay equipos"
        text="Registra los equipos de este turno y día para generar la tabla general automáticamente."
      >
        <button className="btn-primary" onClick={() => goTo('equipos')}>Registrar equipos</button>
      </Empty>
    );
  }
  const formColor = { G: 'bg-pitch text-night-950', E: 'bg-slate-500 text-white', P: 'bg-card-red text-white' };
  return (
    <div>
      <SectionTitle title="Tabla general" subtitle="Se actualiza sola al finalizar cada partido." />
      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-night-800/70 text-[11px] uppercase tracking-widest text-slate-400">
                <th className="py-3 pl-4 text-left">#</th>
                <th className="px-2 text-left">Equipo</th>
                {['PJ', 'PG', 'PE', 'PP', 'GF', 'GC', 'DG'].map((h) => (
                  <th key={h} className="px-2 text-center">{h}</th>
                ))}
                <th className="px-2 text-center text-pitch">PTS</th>
                <th className="pr-4 text-center">Forma</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((r, i) => (
                <tr
                  key={r.team.id}
                  className={`border-b border-white/5 transition hover:bg-white/[0.04] ${i === 0 && r.pj > 0 ? 'bg-pitch/[0.06]' : ''}`}
                >
                  <td className="py-3 pl-4">
                    <span
                      className={`inline-flex h-7 w-7 items-center justify-center rounded-md font-display text-lg font-bold ${
                        i === 0 && r.pj > 0 ? 'bg-gold text-night-950' : 'bg-white/5 text-slate-300'
                      }`}
                    >
                      {i + 1}
                    </span>
                  </td>
                  <td className="px-2">
                    <div className="flex items-center gap-3">
                      <span className="h-6 w-1.5 rounded-full" style={{ background: r.team.color }} />
                      <span className="font-semibold">{r.team.name}</span>
                    </div>
                  </td>
                  <td className="px-2 text-center tabular-nums">{r.pj}</td>
                  <td className="px-2 text-center tabular-nums">{r.pg}</td>
                  <td className="px-2 text-center tabular-nums">{r.pe}</td>
                  <td className="px-2 text-center tabular-nums">{r.pp}</td>
                  <td className="px-2 text-center tabular-nums">{r.gf}</td>
                  <td className="px-2 text-center tabular-nums">{r.gc}</td>
                  <td className={`px-2 text-center tabular-nums ${r.dg > 0 ? 'text-pitch' : r.dg < 0 ? 'text-red-400' : ''}`}>
                    {r.dg > 0 ? `+${r.dg}` : r.dg}
                  </td>
                  <td className="px-2 text-center font-display text-2xl font-extrabold text-pitch tabular-nums">{r.pts}</td>
                  <td className="pr-4">
                    <div className="flex justify-center gap-1">
                      {r.form.slice(-5).map((f, k) => (
                        <span key={k} className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${formColor[f]}`}>
                          {f}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Criterios de desempate: puntos, diferencia de goles, goles a favor y orden alfabético. Victoria = {POINTS_WIN} pts · Empate = {POINTS_DRAW} pt.
      </p>
    </div>
  );
}

/* ============================================================
   VISTA: EQUIPOS Y JUGADORES
   ============================================================ */
function TeamCard({ team, league, disc, suspendedIds, onRemoveTeam, onAddPlayer, onRemovePlayer }) {
  const [name, setName] = useState('');
  const [num, setNum] = useState('');
  const players = league.players.filter((p) => p.teamId === team.id);
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAddPlayer(team.id, name.trim(), num);
    setName('');
    setNum('');
  };
  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3" style={{ borderTop: `3px solid ${team.color}` }}>
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg font-display text-xl font-extrabold text-night-950" style={{ background: team.color }}>
            {team.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <p className="font-display text-xl font-bold uppercase leading-none">{team.name}</p>
            <p className="text-xs text-slate-400">{players.length} jugadores</p>
          </div>
        </div>
        <button className="btn-danger !px-3 !py-1.5 text-xs" onClick={() => onRemoveTeam(team.id)}>Eliminar</button>
      </div>
      <div className="space-y-1 p-3">
        {players.length === 0 && <p className="px-1 py-2 text-sm text-slate-500">Sin jugadores registrados.</p>}
        {players
          .slice()
          .sort((a, b) => (a.number || 999) - (b.number || 999))
          .map((p) => {
            const s = disc.stats[p.id] || { y: 0, dy: 0, r: 0 };
            return (
              <div key={p.id} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="w-7 text-center font-display text-lg font-bold text-slate-400">{p.number || '–'}</span>
                  <span className="text-sm font-medium">{p.name}</span>
                  {suspendedIds.has(p.id) && (
                    <span className="rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-400">Suspendido</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-xs text-slate-400">
                    {s.y > 0 && <><CardChip type="yellow" />{s.y}</>}
                    {s.dy > 0 && <><CardChip type="double_yellow" />{s.dy}</>}
                    {s.r > 0 && <><CardChip type="red" />{s.r}</>}
                  </span>
                  <button className="text-xs text-slate-500 hover:text-red-400" onClick={() => onRemovePlayer(p.id)}>✕</button>
                </div>
              </div>
            );
          })}
        <form onSubmit={submit} className="flex gap-2 pt-2">
          <input className="field !w-16 text-center" placeholder="#" inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, '').slice(0, 3))} />
          <input className="field" placeholder="Nombre del jugador" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary shrink-0" type="submit">Agregar</button>
        </form>
      </div>
    </div>
  );
}

function EquiposView({ league, disc, suspendedIds, onAddTeam, onRemoveTeam, onAddPlayer, onRemovePlayer }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(TEAM_COLORS[0]);
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAddTeam(name.trim(), color);
    setName('');
    setColor(TEAM_COLORS[(league.teams.length + 1) % TEAM_COLORS.length]);
  };
  return (
    <div>
      <SectionTitle title="Equipos y plantillas" subtitle="Registra equipos y jugadores. Los jugadores son necesarios para asignar tarjetas." />
      <form onSubmit={submit} className="panel mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <input className="field" placeholder="Nombre del equipo (ej. Halcones FC)" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex items-center gap-1.5">
          {TEAM_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => setColor(c)}
              className={`h-7 w-7 rounded-full transition ${color === c ? 'scale-110 ring-2 ring-white' : 'opacity-70 hover:opacity-100'}`}
              style={{ background: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
        <button className="btn-primary shrink-0" type="submit">Registrar equipo</button>
      </form>
      {league.teams.length === 0 ? (
        <Empty title="Sin equipos" text="Agrega el primer equipo para comenzar la liga de este turno." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {league.teams.map((t) => (
            <TeamCard key={t.id} team={t} league={league} disc={disc} suspendedIds={suspendedIds} onRemoveTeam={onRemoveTeam} onAddPlayer={onAddPlayer} onRemovePlayer={onRemovePlayer} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   VISTA: JORNADAS
   ============================================================ */
function MatchCard({ m, league, teamById, disc, onScore, onTogglePlayed, onRemove, onAddCard, onRemoveCard }) {
  const home = teamById[m.homeId];
  const away = teamById[m.awayId];
  const [open, setOpen] = useState(false);
  const [cTeam, setCTeam] = useState(m.homeId);
  const [cPlayer, setCPlayer] = useState('');
  const [cType, setCType] = useState('yellow');
  const [cMin, setCMin] = useState('');
  const [msg, setMsg] = useState(null);

  if (!home || !away) return null;
  const susHere = disc.susForMatch[m.id] || [];
  const isSus = (pid) => susHere.some((s) => s.playerId === pid);
  const roster = league.players.filter((p) => p.teamId === cTeam);
  const pById = Object.fromEntries(league.players.map((p) => [p.id, p]));
  const cards = (m.cards || []).slice().sort((a, b) => (parseInt(a.minute) || 0) - (parseInt(b.minute) || 0));

  const submit = () => {
    const r = onAddCard(m.id, cPlayer, cType, cMin);
    setMsg(r);
    if (!r.error) { setCPlayer(''); setCMin(''); }
  };

  const Score = ({ side }) => {
    const val = side === 'home' ? m.homeGoals : m.awayGoals;
    return (
      <div className="flex items-center gap-2">
        <button className="btn-ghost h-8 w-8 !px-0" disabled={m.played || val <= 0} onClick={() => onScore(m.id, side, -1)}>−</button>
        <span className="w-10 text-center font-display text-5xl font-extrabold tabular-nums">{val}</span>
        <button className="btn-ghost h-8 w-8 !px-0" disabled={m.played} onClick={() => onScore(m.id, side, 1)}>+</button>
      </div>
    );
  };

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/10 bg-night-800/60 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">Jornada {m.round}</span>
        <span className={`rounded-full px-3 py-0.5 text-[11px] font-bold uppercase tracking-wide ${m.played ? 'bg-pitch/15 text-pitch' : 'bg-amber-400/15 text-amber-300'}`}>
          {m.played ? 'Finalizado' : 'Pendiente'}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="h-1.5 w-12 rounded-full" style={{ background: home.color }} />
          <p className="font-display text-xl font-bold uppercase leading-tight sm:text-2xl">{home.name}</p>
          <Score side="home" />
        </div>
        <span className="font-display text-xl font-bold text-slate-500">VS</span>
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="h-1.5 w-12 rounded-full" style={{ background: away.color }} />
          <p className="font-display text-xl font-bold uppercase leading-tight sm:text-2xl">{away.name}</p>
          <Score side="away" />
        </div>
      </div>

      {susHere.length > 0 && (
        <div className="mx-4 mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <p className="mb-1 font-bold uppercase tracking-wide">⛔ Suspendidos para este partido</p>
          {susHere.map((s) => (
            <p key={s.playerId}>
              {pById[s.playerId]?.name || 'Jugador'} ({teamById[s.teamId]?.name}) — {s.reason}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-3">
        <button className={m.played ? 'btn-ghost' : 'btn-primary'} onClick={() => onTogglePlayed(m.id)}>
          {m.played ? 'Reabrir partido' : 'Finalizar partido'}
        </button>
        <button className="btn-ghost" onClick={() => setOpen(!open)}>
          Tarjetas ({cards.length}) {open ? '▲' : '▼'}
        </button>
        <button className="btn-danger ml-auto !px-3" onClick={() => onRemove(m.id)}>Eliminar</button>
      </div>

      {open && (
        <div className="border-t border-white/10 bg-night-950/50 p-4">
          <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-400">Registrar tarjeta</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <select className="field" value={cTeam} onChange={(e) => { setCTeam(e.target.value); setCPlayer(''); }}>
              <option value={m.homeId}>{home.name}</option>
              <option value={m.awayId}>{away.name}</option>
            </select>
            <select className="field" value={cPlayer} onChange={(e) => setCPlayer(e.target.value)}>
              <option value="">Jugador…</option>
              {roster.map((p) => (
                <option key={p.id} value={p.id} disabled={isSus(p.id)}>
                  {p.number ? `#${p.number} ` : ''}{p.name}{isSus(p.id) ? ' — SUSPENDIDO' : ''}
                </option>
              ))}
            </select>
            <select className="field" value={cType} onChange={(e) => setCType(e.target.value)}>
              {Object.entries(CARD_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <div className="flex gap-2">
              <input className="field" placeholder="Min." inputMode="numeric" value={cMin} onChange={(e) => setCMin(e.target.value.replace(/\D/g, '').slice(0, 3))} />
              <button className="btn-primary shrink-0" onClick={submit}>Agregar</button>
            </div>
          </div>
          {roster.length === 0 && <p className="mt-2 text-xs text-amber-300">Este equipo no tiene jugadores. Regístralos en la pestaña Equipos.</p>}
          {msg?.error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">⛔ {msg.error}</p>}
          {msg?.info && <p className="mt-3 rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-300">⚠️ {msg.info}</p>}

          <div className="mt-4 space-y-1">
            {cards.length === 0 && <p className="text-sm text-slate-500">Sin tarjetas en este partido.</p>}
            {cards.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg bg-white/[0.04] px-3 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <CardChip type={c.type} />
                  <span className="font-medium">{pById[c.playerId]?.name || 'Jugador eliminado'}</span>
                  <span className="text-xs text-slate-500">{teamById[c.teamId]?.name}</span>
                  {c.minute && <span className="text-xs text-slate-400">{c.minute}'</span>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="hidden text-xs text-slate-400 sm:inline">{CARD_LABEL[c.type]}</span>
                  <button className="text-xs text-slate-500 hover:text-red-400" onClick={() => onRemoveCard(m.id, c.id)}>✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function JornadasView({ league, teamById, disc, handlers, goTo }) {
  const rounds = [...new Set(league.matches.map((m) => m.round))].sort((a, b) => a - b);
  const [filter, setFilter] = useState('all');
  const [round, setRound] = useState(1);
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');

  useEffect(() => {
    if (rounds.length) setRound((r) => (r < 1 ? 1 : r));
  }, [rounds.length]);

  if (league.teams.length < 2) {
    return (
      <Empty title="Necesitas al menos 2 equipos" text="Registra equipos para poder programar jornadas y capturar marcadores.">
        <button className="btn-primary" onClick={() => goTo('equipos')}>Ir a Equipos</button>
      </Empty>
    );
  }

  const submit = (e) => {
    e.preventDefault();
    if (!home || !away || home === away) return;
    handlers.addMatch(Number(round) || 1, home, away);
    setHome('');
    setAway('');
  };
  const visible = league.matches
    .filter((m) => filter === 'all' || String(m.round) === filter)
    .sort((a, b) => a.round - b.round || a.created - b.created);
  const grouped = visible.reduce((acc, m) => ((acc[m.round] = acc[m.round] || []).push(m), acc), {});

  return (
    <div>
      <SectionTitle
        title="Jornadas"
        subtitle="Captura marcadores y tarjetas. Los suspendidos quedan bloqueados automáticamente."
        action={
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={() => handlers.generateFixture(false)}>Generar calendario (ida)</button>
            <button className="btn-ghost" onClick={() => handlers.generateFixture(true)}>Ida y vuelta</button>
          </div>
        }
      />
      <form onSubmit={submit} className="panel mb-5 grid gap-3 p-4 sm:grid-cols-[100px_1fr_1fr_auto]">
        <input className="field" type="number" min="1" value={round} onChange={(e) => setRound(e.target.value)} placeholder="Jornada" />
        <select className="field" value={home} onChange={(e) => setHome(e.target.value)}>
          <option value="">Local…</option>
          {league.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select className="field" value={away} onChange={(e) => setAway(e.target.value)}>
          <option value="">Visitante…</option>
          {league.teams.filter((t) => t.id !== home).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="btn-primary" type="submit">Programar partido</button>
      </form>

      {rounds.length > 0 && (
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
          {['all', ...rounds.map(String)].map((r) => (
            <button
              key={r}
              onClick={() => setFilter(r)}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition ${filter === r ? 'bg-pitch text-night-950' : 'bg-white/5 text-slate-300 hover:bg-white/10'}`}
            >
              {r === 'all' ? 'Todas' : `J${r}`}
            </button>
          ))}
        </div>
      )}

      {league.matches.length === 0 ? (
        <Empty title="Sin partidos programados" text="Programa partidos manualmente o genera el calendario completo con un clic." />
      ) : (
        Object.entries(grouped).map(([r, ms]) => (
          <div key={r} className="mb-6">
            <h3 className="mb-3 font-display text-xl font-bold uppercase tracking-widest text-pitch">Jornada {r}</h3>
            <div className="grid gap-4 xl:grid-cols-2">
              {ms.map((m) => (
                <MatchCard
                  key={m.id}
                  m={m}
                  league={league}
                  teamById={teamById}
                  disc={disc}
                  onScore={handlers.setScore}
                  onTogglePlayed={handlers.togglePlayed}
                  onRemove={handlers.removeMatch}
                  onAddCard={handlers.addCard}
                  onRemoveCard={handlers.removeCard}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ============================================================
   VISTA: DISCIPLINA
   ============================================================ */
function DisciplinaView({ league, teamById, disc, upcoming }) {
  const pById = Object.fromEntries(league.players.map((p) => [p.id, p]));
  const rows = league.players
    .map((p) => {
      const s = disc.stats[p.id] || { y: 0, dy: 0, r: 0, accum: 0 };
      return { p, s };
    })
    .filter(({ s }) => s.y + s.dy + s.r > 0)
    .sort((a, b) => b.s.r + b.s.dy - (a.s.r + a.s.dy) || b.s.y - a.s.y);
  const suspendedIds = new Set(upcoming.map((u) => u.playerId));

  return (
    <div>
      <SectionTitle title="Control disciplinario" subtitle="Tarjetas acumuladas y jugadores suspendidos del turno seleccionado." />
      <div className="panel mb-5 border-red-500/20 p-4">
        <h3 className="mb-3 flex items-center gap-2 font-display text-xl font-bold uppercase tracking-wide text-red-400">⛔ Suspendidos próximo partido</h3>
        {upcoming.length === 0 ? (
          <p className="text-sm text-slate-400">No hay jugadores suspendidos actualmente.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {upcoming.map((u, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg bg-red-500/10 px-3 py-2">
                <div>
                  <p className="text-sm font-semibold">{pById[u.playerId]?.name || 'Jugador'}</p>
                  <p className="text-xs text-slate-400">{teamById[u.teamId]?.name} · {u.reason}</p>
                </div>
                <span className="text-xs font-semibold text-red-300">
                  {u.match ? `Jornada ${u.match.round}` : 'Próximo partido'}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Reglas: roja directa = 1 partido · doble amarilla = 1 partido · {YELLOW_LIMIT} amarillas acumuladas = 1 partido (el contador se reinicia).
        </p>
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-night-800/70 text-[11px] uppercase tracking-widest text-slate-400">
                <th className="py-3 pl-4 text-left">Jugador</th>
                <th className="px-2 text-left">Equipo</th>
                <th className="px-2 text-center">Amarillas</th>
                <th className="px-2 text-center">Dobles</th>
                <th className="px-2 text-center">Rojas</th>
                <th className="px-2 text-center">Acumuladas</th>
                <th className="pr-4 text-center">Estado</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="py-10 text-center text-slate-500">Aún no hay tarjetas registradas.</td></tr>
              )}
              {rows.map(({ p, s }) => {
                const sus = suspendedIds.has(p.id);
                const risk = !sus && s.accum === YELLOW_LIMIT - 1;
                return (
                  <tr key={p.id} className="border-b border-white/5 hover:bg-white/[0.04]">
                    <td className="py-3 pl-4 font-medium">{p.number ? `#${p.number} ` : ''}{p.name}</td>
                    <td className="px-2 text-slate-300">{teamById[p.teamId]?.name}</td>
                    <td className="px-2 text-center tabular-nums">{s.y}</td>
                    <td className="px-2 text-center tabular-nums">{s.dy}</td>
                    <td className="px-2 text-center tabular-nums">{s.r}</td>
                    <td className="px-2 text-center tabular-nums">{s.accum}/{YELLOW_LIMIT}</td>
                    <td className="pr-4 text-center">
                      {sus ? (
                        <span className="rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-red-400">Suspendido</span>
                      ) : risk ? (
                        <span className="rounded bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300">En riesgo</span>
                      ) : (
                        <span className="rounded bg-pitch/10 px-2 py-0.5 text-[10px] font-bold uppercase text-pitch">Disponible</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   VISTA: AJUSTES (nombre, Supabase, respaldo)
   ============================================================ */
function AjustesView({ data, setData, cfg, saveCfg, status, errMsg, resetLeague, notify }) {
  const [url, setUrl] = useState(cfg.url || '');
  const [key, setKey] = useState(cfg.key || '');
  const [name, setName] = useState(data.name);
  const fileRef = useRef(null);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `respaldo-liga-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(r.result);
        if (!parsed.leagues || typeof parsed.leagues !== 'object') throw new Error('Formato inválido');
        setData({ ...parsed, _by: CLIENT_ID });
        notify('Respaldo importado correctamente.');
      } catch {
        notify('El archivo no es un respaldo válido.', 'error');
      }
    };
    r.readAsText(f);
    e.target.value = '';
  };

  return (
    <div className="space-y-5">
      <SectionTitle title="Ajustes" subtitle="Personaliza la liga y conecta la base de datos en la nube." />

      <div className="panel p-5">
        <h3 className="mb-3 font-display text-xl font-bold uppercase tracking-wide">Nombre de la liga</h3>
        <div className="flex gap-2">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary shrink-0" onClick={() => setData((d) => ({ ...d, name: name.trim() || 'LIGA PRO', _by: CLIENT_ID }))}>Guardar</button>
        </div>
      </div>

      <div className="panel p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-xl font-bold uppercase tracking-wide">Conexión Supabase</h3>
          <StatusPill status={status} />
        </div>
        <p className="mb-4 text-sm text-slate-400">
          Pega la URL del proyecto y la clave <b>anon public</b> (Project Settings → API). Los datos se sincronizan en tiempo real entre todos los dispositivos.
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <input className="field" placeholder="https://xxxx.supabase.co" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input className="field" type="password" placeholder="anon public key" value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        {status === 'error' && errMsg && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{errMsg}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => saveCfg({ url, key })}>Guardar y conectar</button>
          <button className="btn-ghost" onClick={() => { setUrl(''); setKey(''); saveCfg({ url: '', key: '' }); }}>Desconectar (modo local)</button>
        </div>
        <details className="mt-5">
          <summary className="cursor-pointer text-sm font-semibold text-pitch">Ver SQL de configuración inicial (ejecutar una sola vez en Supabase → SQL Editor)</summary>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-night-950 p-4 text-xs leading-relaxed text-slate-300">{SQL_SETUP}</pre>
          <button className="btn-ghost mt-2" onClick={() => { navigator.clipboard?.writeText(SQL_SETUP); notify('SQL copiado.'); }}>Copiar SQL</button>
        </details>
      </div>

      <div className="panel p-5">
        <h3 className="mb-3 font-display text-xl font-bold uppercase tracking-wide">Respaldo y mantenimiento</h3>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={exportJson}>Exportar respaldo (JSON)</button>
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Importar respaldo</button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={importJson} />
          <button className="btn-danger" onClick={resetLeague}>Borrar datos del turno/día actual</button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   APLICACIÓN PRINCIPAL
   ============================================================ */
export default function Page() {
  const [ready, setReady] = useState(false);
  const [data, setData] = useState({ name: 'LIGA PRO', leagues: {}, _by: 'init' });
  const [turno, setTurno] = useState('Matutino');
  const [dia, setDia] = useState('Sábado');
  const [tab, setTab] = useState('tabla');
  const [cfg, setCfg] = useState({ url: '', key: '' });
  const [status, setStatus] = useState('local');
  const [errMsg, setErrMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const sbRef = useRef(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const notify = useCallback((msg, type = 'ok') => {
    const id = uid();
    setToast({ msg, type, id });
    setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 3500);
  }, []);

  /* ---- Carga inicial desde localStorage ---- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.leagues) setData({ ...parsed, _by: 'local' });
      }
      const c = localStorage.getItem(LS_CFG);
      if (c) setCfg(JSON.parse(c));
      const s = localStorage.getItem(LS_SEL);
      if (s) {
        const sel = JSON.parse(s);
        if (TURNOS.includes(sel.turno)) setTurno(sel.turno);
        if (DIAS.includes(sel.dia)) setDia(sel.dia);
      }
    } catch {}
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(LS_SEL, JSON.stringify({ turno, dia }));
  }, [turno, dia, ready]);

  /* ---- Conexión a Supabase + sincronización en tiempo real ---- */
  useEffect(() => {
    if (!ready) return;
    if (!cfg?.url || !cfg?.key) {
      sbRef.current = null;
      setStatus('local');
      return;
    }
    let cancelled = false;
    let channel = null;
    let sb;
    try {
      sb = createClient(cfg.url.trim(), cfg.key.trim());
    } catch (e) {
      setStatus('error');
      setErrMsg('URL o clave inválida.');
      return;
    }
    sbRef.current = sb;
    setStatus('connecting');
    setErrMsg('');
    (async () => {
      const { data: row, error } = await sb.from(TABLE).select('data').eq('id', ROW_ID).maybeSingle();
      if (cancelled) return;
      if (error) {
        setStatus('error');
        setErrMsg(`${error.message} — ¿Ejecutaste el SQL de configuración inicial?`);
        return;
      }
      if (row?.data) {
        setData({ ...row.data, _by: 'remote' });
      } else {
        await sb.from(TABLE).upsert({ id: ROW_ID, data: dataRef.current, updated_at: new Date().toISOString() });
      }
      setStatus('online');
      channel = sb
        .channel('liga-sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, (payload) => {
          const d = payload.new?.data;
          if (d && d._by !== CLIENT_ID) setData({ ...d });
        })
        .subscribe();
    })();
    return () => {
      cancelled = true;
      if (channel && sb) sb.removeChannel(channel);
    };
  }, [cfg, ready]);

  /* ---- Guardado (localStorage inmediato + Supabase con debounce) ---- */
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(LS_STATE, JSON.stringify(data)); } catch {}
    if (data._by !== CLIENT_ID || !sbRef.current) return;
    setSaving(true);
    const t = setTimeout(async () => {
      const { error } = await sbRef.current.from(TABLE).upsert({ id: ROW_ID, data, updated_at: new Date().toISOString() });
      setSaving(false);
      if (error) {
        setStatus('error');
        setErrMsg(error.message);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [data, ready]);

  const saveCfg = (c) => {
    const clean = { url: (c.url || '').trim(), key: (c.key || '').trim() };
    localStorage.setItem(LS_CFG, JSON.stringify(clean));
    setCfg(clean);
    notify(clean.url ? 'Credenciales guardadas. Conectando…' : 'Modo local activado.');
  };

  /* ---- Datos derivados ---- */
  const key = leagueKey(turno, dia);
  const league = useMemo(() => data.leagues[key] || emptyLeague(), [data, key]);
  const teamById = useMemo(() => Object.fromEntries(league.teams.map((t) => [t.id, t])), [league]);
  const standings = useMemo(() => computeStandings(league), [league]);
  const disc = useMemo(() => computeDiscipline(league), [league]);
  const upcoming = useMemo(() => {
    const list = [];
    league.matches
      .filter((m) => !m.played)
      .forEach((m) => (disc.susForMatch[m.id] || []).forEach((s) => list.push({ ...s, match: m })));
    disc.tail.forEach((s) => list.push({ ...s, match: null }));
    return list;
  }, [league, disc]);
  const suspendedIds = useMemo(() => new Set(upcoming.map((u) => u.playerId)), [upcoming]);

  const updateLeague = useCallback(
    (fn) =>
      setData((prev) => {
        const lg = prev.leagues[key] || emptyLeague();
        return { ...prev, leagues: { ...prev.leagues, [key]: fn(lg) }, _by: CLIENT_ID };
      }),
    [key]
  );

  /* ---- Acciones ---- */
  const addTeam = (name, color) => {
    if (league.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) return notify('Ya existe un equipo con ese nombre.', 'error');
    updateLeague((lg) => ({ ...lg, teams: [...lg.teams, { id: uid(), name, color }] }));
    notify(`Equipo "${name}" registrado.`);
  };
  const removeTeam = (id) => {
    if (!confirm('¿Eliminar el equipo, sus jugadores y todos sus partidos?')) return;
    updateLeague((lg) => ({
      teams: lg.teams.filter((t) => t.id !== id),
      players: lg.players.filter((p) => p.teamId !== id),
      matches: lg.matches.filter((m) => m.homeId !== id && m.awayId !== id),
    }));
  };
  const addPlayer = (teamId, name, number) => {
    updateLeague((lg) => ({ ...lg, players: [...lg.players, { id: uid(), teamId, name, number: number ? Number(number) : null }] }));
  };
  const removePlayer = (id) => {
    updateLeague((lg) => ({
      ...lg,
      players: lg.players.filter((p) => p.id !== id),
      matches: lg.matches.map((m) => ({ ...m, cards: (m.cards || []).filter((c) => c.playerId !== id) })),
    }));
  };
  const newMatch = (round, homeId, awayId, i = 0) => ({
    id: uid(), round, homeId, awayId, homeGoals: 0, awayGoals: 0, played: false, cards: [], created: Date.now() + i,
  });
  const addMatch = (round, homeId, awayId) => {
    updateLeague((lg) => ({ ...lg, matches: [...lg.matches, newMatch(round, homeId, awayId)] }));
    notify('Partido programado.');
  };
  const generateFixture = (double) => {
    const ids = league.teams.map((t) => t.id);
    if (ids.length < 2) return notify('Registra al menos 2 equipos.', 'error');
    if (league.matches.length && !confirm('Ya existen partidos. ¿Agregar el calendario generado de todos modos?')) return;
    const arr = [...ids];
    if (arr.length % 2) arr.push(null);
    const n = arr.length;
    const rounds = [];
    for (let r = 0; r < n - 1; r++) {
      const pairs = [];
      for (let i = 0; i < n / 2; i++) {
        const a = arr[i];
        const b = arr[n - 1 - i];
        if (a && b) pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
      }
      rounds.push(pairs);
      arr.splice(1, 0, arr.pop());
    }
    const out = [];
    let k = 0;
    rounds.forEach((pairs, r) => pairs.forEach(([h, a]) => out.push(newMatch(r + 1, h, a, k++))));
    if (double) rounds.forEach((pairs, r) => pairs.forEach(([h, a]) => out.push(newMatch(r + 1 + rounds.length, a, h, k++))));
    updateLeague((lg) => ({ ...lg, matches: [...lg.matches, ...out] }));
    notify(`Calendario generado: ${out.length} partidos.`);
  };
  const removeMatch = (id) => {
    if (!confirm('¿Eliminar este partido y sus tarjetas?')) return;
    updateLeague((lg) => ({ ...lg, matches: lg.matches.filter((m) => m.id !== id) }));
  };
  const setScore = (id, side, delta) => {
    updateLeague((lg) => ({
      ...lg,
      matches: lg.matches.map((m) => {
        if (m.id !== id || m.played) return m;
        const f = side === 'home' ? 'homeGoals' : 'awayGoals';
        return { ...m, [f]: Math.max(0, m[f] + delta) };
      }),
    }));
  };
  const togglePlayed = (id) => {
    updateLeague((lg) => ({ ...lg, matches: lg.matches.map((m) => (m.id === id ? { ...m, played: !m.played } : m)) }));
  };

  /* Control estricto de tarjetas */
  const addCard = (matchId, playerId, type, minute) => {
    const m = league.matches.find((x) => x.id === matchId);
    const p = league.players.find((x) => x.id === playerId);
    if (!m || !p) return { error: 'Selecciona un jugador.' };
    if ((disc.susForMatch[matchId] || []).some((s) => s.playerId === playerId))
      return { error: `${p.name} está SUSPENDIDO para este partido y no puede ser alineado ni sancionado.` };
    const prev = (m.cards || []).filter((c) => c.playerId === playerId);
    if (prev.some((c) => c.type === 'red' || c.type === 'double_yellow'))
      return { error: `${p.name} ya fue expulsado en este partido.` };
    const hasY = prev.find((c) => c.type === 'yellow');
    let finalType = type;
    let replaceId = null;
    if (hasY && (type === 'yellow' || type === 'double_yellow')) {
      finalType = 'double_yellow';
      replaceId = hasY.id;
    }
    updateLeague((lg) => ({
      ...lg,
      matches: lg.matches.map((x) =>
        x.id !== matchId
          ? x
          : {
              ...x,
              cards: [
                ...(x.cards || []).filter((c) => c.id !== replaceId),
                { id: uid(), playerId, teamId: p.teamId, type: finalType, minute: minute || '' },
              ],
            }
      ),
    }));
    if (finalType === 'double_yellow' && type === 'yellow')
      return { info: `Segunda amarilla: se registró como DOBLE AMARILLA. ${p.name} queda expulsado y suspendido el próximo partido.` };
    if (finalType === 'red') return { info: `${p.name} queda suspendido el próximo partido (roja directa).` };
    return {};
  };
  const removeCard = (matchId, cardId) => {
    updateLeague((lg) => ({
      ...lg,
      matches: lg.matches.map((m) => (m.id === matchId ? { ...m, cards: (m.cards || []).filter((c) => c.id !== cardId) } : m)),
    }));
  };
  const resetLeague = () => {
    if (!confirm(`¿Borrar TODOS los datos de ${turno} · ${dia}? Esta acción no se puede deshacer.`)) return;
    updateLeague(() => emptyLeague());
    notify('Datos del turno/día eliminados.');
  };

  const handlers = { addMatch, generateFixture, removeMatch, setScore, togglePlayed, addCard, removeCard };

  const tabs = [
    { id: 'tabla', label: 'Tabla' },
    { id: 'jornadas', label: 'Jornadas' },
    { id: 'equipos', label: 'Equipos' },
    { id: 'disciplina', label: 'Disciplina', badge: upcoming.length },
    { id: 'ajustes', label: 'Ajustes' },
  ];
  const dayHasData = (t, d) => (data.leagues[leagueKey(t, d)]?.teams.length || 0) > 0;

  if (!ready) return <div className="flex min-h-screen items-center justify-center text-slate-500">Cargando…</div>;

  return (
    <div className="min-h-screen bg-hero bg-pitch-lines">
      {/* HEADER */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-night-950/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-pitch font-display text-2xl font-extrabold text-night-950 shadow-glow">⚽</div>
            <div>
              <h1 className="font-display text-2xl font-extrabold uppercase leading-none tracking-wide sm:text-3xl">{data.name}</h1>
              <p className="text-[11px] uppercase tracking-[0.25em] text-pitch">{turno} · {dia}</p>
            </div>
          </div>
          <StatusPill status={status} saving={saving} />
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative shrink-0 px-4 py-3 font-display text-lg font-bold uppercase tracking-wider transition ${
                tab === t.id ? 'text-pitch' : 'text-slate-400 hover:text-white'
              }`}
            >
              {t.label}
              {t.badge > 0 && <span className="ml-1.5 rounded-full bg-card-red px-1.5 py-0.5 text-[10px] text-white">{t.badge}</span>}
              {tab === t.id && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-pitch shadow-glow-sm" />}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {/* SELECTOR TURNO + DÍA */}
        {tab !== 'ajustes' && (
          <div className="panel mb-6 p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="flex rounded-xl bg-night-800 p-1">
                {TURNOS.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTurno(t)}
                    className={`flex-1 rounded-lg px-5 py-2 font-display text-lg font-bold uppercase tracking-wide transition lg:flex-none ${
                      turno === t ? 'bg-pitch text-night-950 shadow-glow-sm' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {t === 'Matutino' ? '☀️' : '🌙'} {t}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5 overflow-x-auto pb-1 lg:pb-0">
                {DIAS.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDia(d)}
                    className={`relative shrink-0 rounded-lg border px-4 py-2 text-sm font-semibold transition ${
                      dia === d ? 'border-pitch bg-pitch/10 text-pitch' : 'border-white/10 text-slate-300 hover:bg-white/5'
                    }`}
                  >
                    {d}
                    {dayHasData(turno, d) && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-pitch" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'tabla' && <TablaView standings={standings} league={league} goTo={setTab} />}
        {tab === 'jornadas' && <JornadasView league={league} teamById={teamById} disc={disc} handlers={handlers} goTo={setTab} />}
        {tab === 'equipos' && (
          <EquiposView league={league} disc={disc} suspendedIds={suspendedIds} onAddTeam={addTeam} onRemoveTeam={removeTeam} onAddPlayer={addPlayer} onRemovePlayer={removePlayer} />
        )}
        {tab === 'disciplina' && <DisciplinaView league={league} teamById={teamById} disc={disc} upcoming={upcoming} />}
        {tab === 'ajustes' && (
          <AjustesView data={data} setData={setData} cfg={cfg} saveCfg={saveCfg} status={status} errMsg={errMsg} resetLeague={resetLeague} notify={notify} />
        )}
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-center text-xs text-slate-600">
        {data.name} · Sistema de gestión de ligas
      </footer>

      {toast && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <div className={`rounded-xl border px-5 py-3 text-sm font-semibold shadow-2xl backdrop-blur ${toast.type === 'error' ? 'border-red-500/40 bg-red-950/90 text-red-200' : 'border-pitch/40 bg-night-800/95 text-pitch'}`}>
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}
