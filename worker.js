// Nova relay v27: news, calendar (+ drive times), Jellyfin (+ Wrapped), game day, live games, highlights, hockey hub, 511 traffic, planes.
// Optional secret TOMTOM_KEY = your free TomTom key (live traffic map).
// Optional secret HOME = "lat,lon" of your home, so drive times start from your door instead of the middle of town.
// Secrets (Settings -> Runtime variables and secrets): CAL_ICS, CAL_KEY, JF_URL, JF_KEY, ON511_KEY
// Only your dashboard site can use it, and calendar/Jellyfin need your CAL_KEY.

// ★ Your GitHub Pages address (where index.html lives). Only pages from here may use this relay.
const ALLOWED_ORIGINS = [
  'https://YOUR-GITHUB-NAME.github.io',
];
const OK_TYPES = /(xml|rss|atom|calendar|json|text\/plain)/i;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response('Not allowed', { status: 403, headers: cors });

    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname;
    const keyOk = () => env.CAL_KEY && reqUrl.searchParams.get('key') === env.CAL_KEY;
    const json = (obj, status = 200) => {
      const h = new Headers(cors);
      h.set('Content-Type', 'application/json; charset=utf-8');
      h.set('Cache-Control', 'no-store');
      return new Response(JSON.stringify(obj), { status, headers: h });
    };

    /* ---- private calendar: /calendar?key=... ---- */
    if (path === '/calendar') {
      if (!env.CAL_ICS || !env.CAL_KEY) return new Response('Calendar not set up', { status: 500, headers: cors });
      if (!keyOk()) return new Response('Forbidden', { status: 403, headers: cors });
      const cal = await fetch(env.CAL_ICS.replace(/^webcal:/i, 'https:'), { cf: { cacheTtl: 300 }, redirect: 'follow' });
      const h = new Headers(cors);
      h.set('Content-Type', 'text/plain; charset=utf-8');
      h.set('Cache-Control', 'no-store');
      return new Response(await cal.text(), { status: cal.status, headers: h });
    }

    /* ---- Jellyfin: /jellyfin?key=...  and  /jellyfin/img?key=...&id=...&type=Primary[&size=s] ---- */
    if (path === '/jellyfin' || path === '/jellyfin/img') {
      if (!env.JF_URL || !env.JF_KEY) return json({ error: 'Jellyfin not set up' }, 500);
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      const base = env.JF_URL.replace(/\/+$/, '');
      const jfh = { 'Authorization': `MediaBrowser Token="${env.JF_KEY}"`, 'Accept': 'application/json' };

      if (path === '/jellyfin/img') {
        const id = reqUrl.searchParams.get('id') || '';
        const type = reqUrl.searchParams.get('type') || 'Primary';
        if (!/^[0-9a-f]{32}$/i.test(id) || !/^(Primary|Backdrop|Thumb|Logo)$/.test(type)) return new Response('Bad image', { status: 400, headers: cors });
        const small = reqUrl.searchParams.get('size') === 's';
        const size = small ? 'maxHeight=360' : (type === 'Primary' ? 'maxHeight=900' : 'maxWidth=1600');
        const img = await fetch(`${base}/Items/${id}/Images/${type}?${size}&quality=85`, { headers: jfh, cf: { cacheTtl: 86400 } });
        const h = new Headers(cors);
        h.set('Content-Type', img.headers.get('Content-Type') || 'image/jpeg');
        h.set('Cache-Control', 'public, max-age=86400');
        return new Response(img.body, { status: img.status, headers: h });
      }

      const get = async p => {
        const r = await fetch(base + p, { headers: jfh });
        if (!r.ok) throw new Error(p + ' ' + r.status);
        return r.json();
      };
      const t0 = Date.now();
      let info;
      try { info = await get('/System/Info'); }
      catch (e) { return json({ up: false, error: String(e.message || e), at: Date.now() }); }
      const ping = Date.now() - t0;

      const [sessions, log, counts, users] = await Promise.all([
        get('/Sessions?activeWithinSeconds=900').catch(() => []),
        get('/System/ActivityLog/Entries?limit=150').catch(() => ({ Items: [] })),
        get('/Items/Counts').catch(() => ({})),
        get('/Users').catch(() => []),
      ]);

      const hex = v => (typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v.replace(/-/g, ''))) ? v.replace(/-/g, '') : '';
      const streams = (sessions || []).filter(s => s.NowPlayingItem).map(s => {
        const it = s.NowPlayingItem, ps = s.PlayState || {}, ti = s.TranscodingInfo || null;
        const ep = it.Type === 'Episode';
        const streamBits = (it.MediaStreams || []).reduce((a, m) => a + (m.BitRate || 0), 0);
        return {
          user: s.UserName || 'Someone',
          device: s.DeviceName || '', client: s.Client || '',
          type: it.Type || '',
          title: it.Name || '',
          series: ep ? (it.SeriesName || '') : '',
          season: ep ? it.ParentIndexNumber : null, episode: ep ? it.IndexNumber : null,
          year: it.ProductionYear || null,
          poster: hex(ep ? (it.SeriesId || it.Id) : it.Id),
          backdrop: hex(it.ParentBackdropItemId || ((it.BackdropImageTags || []).length ? it.Id : '') || (ep ? it.SeriesId : '')),
          pos: ps.PositionTicks ? ps.PositionTicks / 1e7 : 0,
          dur: it.RunTimeTicks ? it.RunTimeTicks / 1e7 : 0,
          paused: !!ps.IsPaused,
          method: ps.PlayMethod || (ti ? 'Transcode' : 'DirectPlay'),
          bitrate: (ti && ti.Bitrate) || streamBits || 0,
          reasons: ti && ti.TranscodeReasons ? [].concat(ti.TranscodeReasons) : [],
          hw: ti ? (ti.HardwareAccelerationType || '') : '',
        };
      });

      const entries = (log && log.Items) || [];
      const problems = entries
        .filter(e => /^(Error|Warning|Critical)$/i.test(e.Severity || ''))
        .slice(0, 6)
        .map(e => ({ level: e.Severity, text: e.Name || e.ShortOverview || '', date: e.Date }));

      /* recently watched: finished plays from the activity log, newest first, no repeats */
      const recent = [], seen = new Set();
      for (const e of entries) {
        if (!/PlaybackStopped$/i.test(e.Type || '')) continue;
        const m = String(e.Name || '').match(/^(.+?) has finished playing (.+?) on (.+)$/i);
        const item = hex(e.ItemId || '');
        const r = { user: m ? m[1] : '', text: m ? m[2] : String(e.Name || ''), device: m ? m[3] : '', date: e.Date, item };
        const k = r.user + '|' + (item || r.text);
        if (seen.has(k)) continue;
        seen.add(k); recent.push(r);
        if (recent.length >= 8) break;
      }
      const ids = recent.map(r => r.item).filter(Boolean);
      if (ids.length) {
        const found = await get('/Items?ids=' + ids.join(',') + '&fields=ProductionYear&enableImages=false').catch(() => ({ Items: [] }));
        const byId = {};
        (found.Items || []).forEach(it => { byId[hex(it.Id)] = it; });
        recent.forEach(r => {
          const it = byId[r.item]; if (!it) return;
          const ep = it.Type === 'Episode';
          r.type = it.Type || '';
          r.title = ep ? (it.SeriesName || it.Name) : it.Name;
          r.sub = ep ? `S${it.ParentIndexNumber ?? '?'} · E${it.IndexNumber ?? '?'} · ${it.Name}` : (it.ProductionYear ? String(it.ProductionYear) : (it.Type || ''));
          r.poster = hex(ep ? (it.SeriesId || it.Id) : it.Id);
        });
      }

      const people = (users || [])
        .filter(u => !(u.Policy && u.Policy.IsDisabled))
        .map(u => ({ name: u.Name || '', last: u.LastActivityDate || u.LastLoginDate || null }))
        .sort((a, b) => (Date.parse(b.last || 0) || 0) - (Date.parse(a.last || 0) || 0));

      return json({
        up: true, ping, at: Date.now(),
        server: info.ServerName || 'Jellyfin', version: info.Version || '',
        restart: !!info.HasPendingRestart, update: !!info.HasUpdateAvailable,
        devices: (sessions || []).length,
        streams, problems, recent, people,
        library: { movies: counts.MovieCount || 0, shows: counts.SeriesCount || 0, episodes: counts.EpisodeCount || 0 },
      });
    }

    /* ---------- shared helpers for the new pages ---------- */
    const cached = async (name, ttl, make) => {
      const ck = new Request('https://nova-cache.local/' + name);
      const hit = await caches.default.match(ck);
      if (hit) return hit.json();
      const data = await make();
      await caches.default.put(ck, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + ttl } }));
      return data;
    };
    const getJSON = async (url, opts = {}) => {
      const r = await fetch(url, { headers: { 'User-Agent': 'NovaDashboard/1.0', 'Accept': 'application/json', ...(opts.headers || {}) }, cf: opts.cf });
      if (!r.ok) throw new Error(new URL(url).hostname + ' ' + r.status);
      return r.json();
    };
    const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
    const R = 6371;
    const distKm = (a1, o1, a2, o2) => { const t = Math.PI / 180, dA = (a2 - a1) * t, dO = (o2 - o1) * t;
      const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * t) * Math.cos(a2 * t) * Math.sin(dO / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
    const bearing = (a1, o1, a2, o2) => { const t = Math.PI / 180, y = Math.sin((o2 - o1) * t) * Math.cos(a2 * t),
      x = Math.cos(a1 * t) * Math.sin(a2 * t) - Math.sin(a1 * t) * Math.cos(a2 * t) * Math.cos((o2 - o1) * t); return (Math.atan2(y, x) / t + 360) % 360; };

    /* ---------- Leafs game day board: /gameday?team=TOR ---------- */
    if (path === '/gameday') {
      const team = (reqUrl.searchParams.get('team') || 'TOR').toUpperCase();
      if (!/^[A-Z]{3}$/.test(team)) return json({ error: 'Bad team' }, 400);
      try {
        const data = await cached('gameday-' + team + '-v2', 300, async () => {
          const NHL = 'https://api-web.nhle.com/v1';
          const sched = await getJSON(`${NHL}/club-schedule-season/${team}/now`);
          const games = (sched.games || []).filter(g => g.gameType === 2 || g.gameType === 3 || g.gameType === undefined);
          const now = Date.now();
          const done = g => /^(OFF|FINAL)$/.test(g.gameState || '');
          const next = games.find(g => !done(g) && Date.parse(g.startTimeUTC) > now - 5 * 3600e3);
          if (!next) return { game: null };
          const home = next.homeTeam.abbrev === team;
          const oppAbbr = home ? next.awayTeam.abbrev : next.homeTeam.abbrev;
          const tname = t => (t.commonName && t.commonName.default) || (t.name && t.name.default) || t.abbrev;
          const side = t => ({ abbr: t.abbrev, name: tname(t), place: (t.placeName && t.placeName.default) || '', logo: t.darkLogo || t.logo || '' });
          const result = (g, ab) => { const me = g.homeTeam.abbrev === ab ? g.homeTeam : g.awayTeam, them = me === g.homeTeam ? g.awayTeam : g.homeTeam;
            const ot = /OT|SO/.test((g.gameOutcome && g.gameOutcome.lastPeriodType) || ''); return me.score > them.score ? 'W' : ot ? 'OT' : 'L'; };

          const [stand, rail, oppSched, usStats, oppStats] = await Promise.all([
            getJSON(`${NHL}/standings/now`).catch(() => ({ standings: [] })),
            getJSON(`${NHL}/gamecenter/${next.id}/right-rail`).catch(() => ({})),
            getJSON(`${NHL}/club-schedule-season/${oppAbbr}/now`).catch(() => ({ games: [] })),
            getJSON(`${NHL}/club-stats/${team}/now`).catch(() => ({})),
            getJSON(`${NHL}/club-stats/${oppAbbr}/now`).catch(() => ({})),
          ]);

          const nm = p => [p.firstName && p.firstName.default, p.lastName && p.lastName.default].filter(Boolean).join(' ');
          const build = (ab, statsResp, schedGames, railSide) => {
            const st = (stand.standings || []).find(s => s.teamAbbrev && s.teamAbbrev.default === ab) || {};
            const gp = st.gamesPlayed || 0;
            const fin = (schedGames || []).filter(g => done(g) && (g.gameType === 2 || g.gameType === 3));
            const ts = railSide || {};
            const pct = v => v == null ? null : Math.round(v * 1000) / 10;
            return {
              abbr: ab,
              rec: gp ? `${st.wins}-${st.losses}-${st.otLosses}` : '0-0-0',
              pts: st.points || 0, gp,
              l10: st.l10GamesPlayed != null || st.l10Wins != null ? `${st.l10Wins || 0}-${st.l10Losses || 0}-${st.l10OtLosses || 0}` : '',
              streak: st.streakCode ? st.streakCode + (st.streakCount || '') : '',
              div: (st.divisionName || ''), divRank: st.divisionSequence || null,
              gfpg: ts.goalsForPerGamePlayed != null ? Math.round(ts.goalsForPerGamePlayed * 100) / 100 : (gp ? Math.round(st.goalFor / gp * 100) / 100 : null),
              gapg: ts.goalsAgainstPerGamePlayed != null ? Math.round(ts.goalsAgainstPerGamePlayed * 100) / 100 : (gp ? Math.round(st.goalAgainst / gp * 100) / 100 : null),
              pp: pct(ts.ppPctg), pk: pct(ts.pkPctg),
              form: fin.slice(-5).map(g => result(g, ab)),
              goalies: (statsResp.goalies || []).sort((a, b) => (b.gamesPlayed || 0) - (a.gamesPlayed || 0)).slice(0, 2).map(p => ({
                name: nm(p), rec: `${p.wins || 0}-${p.losses || 0}-${p.overtimeLosses || 0}`,
                sv: p.savePercentage != null ? p.savePercentage.toFixed(3).replace(/^0/, '') : '', gaa: p.goalsAgainstAverage != null ? p.goalsAgainstAverage.toFixed(2) : '', img: p.headshot || '' })),
              scorers: (statsResp.skaters || []).sort((a, b) => (b.points || 0) - (a.points || 0) || (b.goals || 0) - (a.goals || 0)).slice(0, 2).map(p => ({
                name: nm(p), g: p.goals || 0, a: p.assists || 0, p: p.points || 0, img: p.headshot || '' })),
            };
          };
          const tss = rail.teamSeasonStats || {};
          const us = build(team, usStats, games, home ? tss.homeTeam : tss.awayTeam);
          const them = build(oppAbbr, oppStats, oppSched.games, home ? tss.awayTeam : tss.homeTeam);

          /* last meeting this season + series */
          const meets = games.filter(g => done(g) && (g.homeTeam.abbrev === oppAbbr || g.awayTeam.abbrev === oppAbbr));
          const lm = meets[meets.length - 1];
          let last = null;
          if (lm) { const me = lm.homeTeam.abbrev === team ? lm.homeTeam : lm.awayTeam, op = me === lm.homeTeam ? lm.awayTeam : lm.homeTeam;
            last = { date: lm.startTimeUTC, us: me.score, them: op.score, home: me === lm.homeTeam, res: result(lm, team) }; }
          const series = { us: meets.filter(g => result(g, team) === 'W').length, them: meets.filter(g => result(g, team) !== 'W').length, played: meets.length };

          return { game: { id: next.id, start: next.startTimeUTC, state: next.gameState, venue: (next.venue && next.venue.default) || '', home, nets: [...new Set((next.tvBroadcasts || []).filter(x => x.countryCode === 'CA').map(x => x.network))], us: side(home ? next.homeTeam : next.awayTeam), them: side(home ? next.awayTeam : next.homeTeam) },
            us, them, last, series };
        });
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Around town: /local?key=...&lat=..&lon=..&r=40&cams=4 (Ontario 511) ---------- */
    /* ---------- Drive times with live traffic (TomTom routing): /drives?key=..&lat=..&lon=..&to=Name|lat|lon;Name|lat|lon ---------- */
    if (path === '/drives') {
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      if (!env.TOMTOM_KEY) return json({ error: 'TomTom key not set up' }, 500);
      const lat = num(reqUrl.searchParams.get('lat'), 43.13), lon = num(reqUrl.searchParams.get('lon'), -80.75);
      const dests = String(reqUrl.searchParams.get('to') || '').split(';').map(x => x.split('|')).filter(x => x.length === 3 && isFinite(+x[1]) && isFinite(+x[2])).slice(0, 6)
        .map(x => ({ name: x[0].slice(0, 40), lat: +x[1], lon: +x[2] }));
      if (!dests.length) return json({ error: 'No destinations' }, 400);
      const tk = encodeURIComponent(String(env.TOMTOM_KEY).trim());
      try {
        const data = await cached('drv-v1-' + encodeURIComponent(lat.toFixed(3) + ',' + lon.toFixed(3) + ';' + dests.map(d => d.name + d.lat + d.lon).join(';')).slice(0, 300), 300, async () => ({
          at: Date.now(),
          drives: await Promise.all(dests.map(async d => {
            try {
              const r = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${lat},${lon}:${d.lat},${d.lon}/json?key=${tk}&traffic=true&travelMode=car&routeType=fastest&computeTravelTimeFor=all&routeRepresentation=summaryOnly`);
              if (!r.ok) { const t = await r.text().catch(() => ''); return { name: d.name, error: 'TomTom ' + r.status + (/not authorized|forbidden|not.*enabled/i.test(t) ? ' (Routing API not enabled on this key)' : '') }; }
              const s = (((await r.json()).routes || [])[0] || {}).summary || {};
              const m = x => x == null ? null : Math.round(x / 60);
              return { name: d.name, min: m(s.travelTimeInSeconds), delay: m(s.trafficDelayInSeconds || 0), free: m(s.noTrafficTravelTimeInSeconds), usual: m(s.historicTrafficTravelTimeInSeconds), km: Math.round((s.lengthInMeters || 0) / 1000) };
            } catch (e) { return { name: d.name, error: String(e.message || e) }; }
          }))
        }));
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Knights hub (OHL / HockeyTech), same shape as the Leafs hub: /khub?team=LDN&ht=KEY ---------- */
    if (path === '/khub') {
      const team = (reqUrl.searchParams.get('team') || 'LDN').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
      const ht = (reqUrl.searchParams.get('ht') || '').replace(/[^a-z0-9]/gi, ''), code = 'ohl';
      if (!ht) return json({ error: 'Missing key' }, 400);
      try {
        const data = await cached(`khub-${team}-v2`, 600, async () => {
          const B = 'https://lscluster.hockeytech.com/feed/index.php';
          const parse = async u => { let t = (await (await fetch(u, { headers: { 'User-Agent': 'NovaDashboard/1.0' } })).text()).trim();
            if (!/^[\[{]/.test(t)) { const a = t.indexOf('('), b = t.lastIndexOf(')'); if (a >= 0 && b > a) t = t.slice(a + 1, b); } return JSON.parse(t); };
          const mk = v => `${B}?feed=modulekit&view=${v}&key=${ht}&client_code=${code}&fmt=json`;
          /* current regular season (or playoffs once they start) */
          const seasons = ((await parse(mk('seasons'))).SiteKit || {}).Seasons || [];
          const today = new Date().toISOString().slice(0, 10);
          const cur = seasons.filter(x => x.career === '1').find(x => x.start_date <= today && today <= (x.end_date || '9999')) || seasons.find(x => x.career === '1' && x.playoff === '0') || seasons[0];
          const sid = cur.season_id;
          const [teamsJ, standJ] = await Promise.all([parse(mk('teamsbyseason') + `&season_id=${sid}`), parse(mk('statviewtype') + `&stat=conference&type=standings&season_id=${sid}`)]);
          const teams = (teamsJ.SiteKit || {}).Teamsbyseason || [], me = teams.find(t => (t.code || '').toUpperCase() === team);
          if (!me) return { error: 'Team not found' };
          const byId = Object.fromEntries(teams.map(t => [String(t.id), t]));
          const rows = (((standJ.SiteKit || {}).Statviewtype) || []).filter(r => r.team_code && r.games_played !== undefined && r.team_code !== '');
          const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
          const my = rows.find(r => r.team_code.toUpperCase() === team) || {};
          const conf = rows.filter(r => r.conference_name === my.conference_name).sort((a, b) => num(b.points) - num(a.points) || num(a.games_played) - num(b.games_played) || num(b.row) - num(a.row));
          const div = conf.filter(r => r.divisname === my.divisname);
          const rankIn = (L, c) => L.findIndex(r => r.team_code === c) + 1;
          const lg = rows, rk = (f, asc) => { const v = f(my), sorted = lg.map(f).sort((a, b) => asc ? a - b : b - a); return [Math.round(v * 100) / 100, sorted.indexOf(v) + 1]; };
          const gp = r => Math.max(1, num(r.games_played));
          const ranks = { pp: rk(r => num(r.power_play_pct)), pk: rk(r => num(r.penalty_kill_pct)), gf: rk(r => Math.round(num(r.goals_for) / gp(r) * 100) / 100), ga: rk(r => Math.round(num(r.goals_against) / gp(r) * 100) / 100, true), of: lg.length };
          const cr = rankIn(conf, team), spots = 8, lead = div[0] || {};
          const line = cr <= spots ? num(my.points) - num((conf[spots] || {}).points) : num(my.points) - num((conf[spots - 1] || {}).points);
          const race = { behindFirst: Math.max(0, num(lead.points) - num(my.points)), leader: lead.team_code === team ? '' : (lead.nickname || lead.name || ''), inSpot: cr <= spots, line, pace: Math.round(num(my.points) / gp(my) * 68) };
          const sw = String(my.streak_wl || '').match(/(\d+)\s*([A-Z]+)/i);
          /* schedule: next games + last game */
          const sched = ((await parse(mk('schedule') + `&season_id=${sid}&team_id=${me.id}`)).SiteKit || {}).Schedule || [];
          const done = sched.filter(g => g.final === '1'), up = sched.filter(g => g.final !== '1');
          const oppOf = g => { const home = String(g.home_team) === String(me.id), oid = home ? g.visiting_team : g.home_team, o = byId[String(oid)] || {};
            return { home, code: (home ? g.visiting_team_code : g.home_team_code) || o.code || '', name: o.nickname || (home ? g.visiting_team_nickname : g.home_team_nickname) || '', logo: o.team_logo_url || '' }; };
          const nets = g => { const b = g.broadcasters || {}, all = [...(b.home_video || []), ...(b.visiting_video || [])].map(x => String(x.name || '').replace(/^FLOHOCKEY$/i, 'FloHockey')).filter(Boolean); return [...new Set(all)].slice(0, 2); };
          const next = up.slice(0, 5).map(g => { const o = oppOf(g); return { start: g.GameDateISO8601, opp: o.name || o.code, code: o.code, logo: o.logo, home: o.home, nets: nets(g), live: g.started === '1' }; });
          let last = null; const lg0 = done[done.length - 1];
          if (lg0) {
            const o = oppOf(lg0), us = num(o.home ? lg0.home_goal_count : lg0.visiting_goal_count), them = num(o.home ? lg0.visiting_goal_count : lg0.home_goal_count), extra = lg0.overtime === '1' || lg0.shootout === '1';
            last = { id: lg0.game_id, date: lg0.GameDateISO8601, us, them, home: o.home, opp: o.name || o.code, ot: extra, so: lg0.shootout === '1', res: us > them ? 'W' : extra ? 'OTL' : 'L', stars: [] };
            try {
              const sm = await parse(`${B}?feed=statviewfeed&view=gameSummary&game_id=${lg0.game_id}&key=${ht}&site_id=2&client_code=${code}&lang=en&league_id=`);
              const U = o.home ? sm.homeTeam : sm.visitingTeam, T = o.home ? sm.visitingTeam : sm.homeTeam, us_ = (U || {}).stats || {}, th_ = (T || {}).stats || {};
              last.sog = [us_.shots, th_.shots]; if (us_.powerPlayOpportunities != null) last.pp = `${us_.powerPlayGoals || 0}/${us_.powerPlayOpportunities}`;
              last.stars = (sm.mostValuablePlayers || []).slice(0, 3).map((m, i) => { const p = m.player || {}, inf = p.info || {}, st = p.stats || {};
                return { star: i + 1, name: [inf.firstName, inf.lastName].filter(Boolean).join(' '), team: (m.team || {}).abbreviation || '', img: m.playerImage || (inf.playerImageURL ? 'https://' + String(inf.playerImageURL).replace(/^https?:\/\//, '') : ''),
                  line: m.isGoalie ? (st.saves != null ? st.saves + ' saves' : st.savePercentage != null ? String(st.savePercentage) + ' SV%' : 'Goalie') : [st.goals ? st.goals + 'G' : '', st.assists ? st.assists + 'A' : ''].filter(Boolean).join(' ') || (st.points ? st.points + ' PTS' : '') }; });
            } catch (e) {}
          }
          /* leaders */
          const pv = (pos, sort, lim) => parse(`${B}?feed=statviewfeed&view=players&season=${sid}&team=${me.id}&position=${pos}&rookies=0&statsType=standard&rosterstatus=undefined&site_id=2&first=0&limit=${lim}&sort=${sort}&league_id=1&lang=en&division=-1&key=${ht}&client_code=${code}${pos === 'goalies' ? '&qualified=all' : ''}`)
            .then(j => ((((j || [])[0] || {}).sections || [])[0] || {}).data || []).then(d => d.map(x => { const p = x.prop || {}, r = x.row || {}; return { ...r, name: (p.name && p.name.seoName) || (p.shortname && p.shortname.seoName) || r.name || r.shortname || '' }; })).catch(() => []);
          const [sk, gk] = await Promise.all([pv('skaters', 'points', 60), pv('goalies', 'gaa', 5)]);
          const img = id => id ? `https://assets.leaguestat.com/${code}/240x240/${id}.jpg` : '';
          const top = k => { const p = sk.slice().sort((a, b) => num(b[k]) - num(a[k]) || num(b.points) - num(a.points))[0]; return p ? { name: String(p.name || ''), v: num(p[k]), img: img(p.player_id) } : null; };
          /* goalie with the best save % among those who've played a real share of the games */
          const mins = gk.reduce((a, g) => a + num(g.minutes_played), 0) || 1;
          const g1 = gk.filter(g => num(g.minutes_played) >= mins * 0.2).sort((a, b) => num(b.save_percentage) - num(a.save_percentage))[0] || gk.slice().sort((a, b) => num(b.games_played) - num(a.games_played))[0];
          const svp = g1 ? (g1.save_percentage || g1.savepct || g1.svpct) : null;
          const leaders = { points: top('points'), goals: top('goals'), assists: top('assists'), save: g1 ? { name: String(g1.name || ''), v: svp != null ? String(svp).replace(/^0(?=\.)/, '') : (g1.gaa || ''), img: img(g1.player_id) } : null };
          /* highlights: the OHL YouTube channel posts every game; remember the newest Knights one for two weeks */
          const nm = (me.name || 'London Knights');
          let videos = [];
          try {
            const rss = await (await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=UCv8PFMGl0wt9qdw5mQf7C3g', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
            const ents = [...rss.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => ({ id: (m[1].match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/) || [])[1], title: ((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), date: (m[1].match(/<published>([^<]+)</) || [])[1] }));
            let hit = ents.find(e => e.id && /highlights/i.test(e.title) && e.title.includes(nm));
            /* the channel feed only lists its latest 15 uploads; if the Knights game has scrolled off, search for it */
            if (!hit) {
              const html = await (await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent('OHL Highlights ' + nm)}&sp=CAI%253D`, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en-CA,en;q=0.9' } })).text();
              for (const m of html.matchAll(/"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,600}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g)) {
                const t = m[2].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
                if (/^OHL Highlights:/i.test(t) && t.includes(nm)) { hit = { id: m[1], title: t }; break; }
              }
            }
            const hk = new Request('https://nova-cache.local/khub-hl-' + team);
            if (hit) await caches.default.put(hk, new Response(JSON.stringify(hit), { headers: { 'Cache-Control': 'max-age=1209600' } }));
            const keep = hit || await caches.default.match(hk).then(r => r ? r.json() : null);
            if (keep) videos = [{ yt: keep.id, title: keep.title.replace(/^OHL Highlights:\s*/i, '') }];
          } catch (e) {}
          /* headlines */
          let news = [];
          try {
            const slug = { LDN: 'knights' }[team] || String(me.nickname || '').toLowerCase().replace(/[^a-z]/g, '');
            const rss = await (await fetch(`https://chl.ca/ohl-${slug}/feed/`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
            const dec = t => String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            news = [...rss.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => { const x = m[1], t = dec((x.match(/<title>([\s\S]*?)<\/title>/) || [])[1]), src = dec((x.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]);
              const img = ((x.match(/<enclosure[^>]+url="([^"]+)"/) || [])[1] || '').replace(/-\d+x\d+(\.\w+)$/, '$1');
              return { title: src && t.endsWith(' - ' + src) ? t.slice(0, -(src.length + 3)) : t, by: src, img, date: (x.match(/<pubDate>([^<]+)</) || [])[1] || '' }; })
              .filter(n => n.title && Date.now() - Date.parse(n.date) < 21 * 864e5).slice(0, 6);
          } catch (e) {}
          return { team, name: me.name, short: me.nickname || 'Knights', logo: me.team_logo_url || '', season: cur.season_name,
            record: [my.wins, my.losses, my.ot_losses, my.shootout_losses].map(v => num(v)).join('-'), pts: num(my.points), gp: num(my.games_played),
            divRank: rankIn(div, team), divName: String(my.divisname || '').replace(/ Division$/, ''), confRank: cr, confName: String(my.conference_name || '').replace(/ Conference$/, ''),
            streak: sw ? sw[2].toUpperCase() + sw[1] : '', l10: my.past_10 || '', next, last, videos, leaders, ranks, race, news, injuries: [], moves: [] };
        });
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Photos: list the image files in your Google Drive folder (key + folder stay in Worker secrets DRIVE_KEY, DRIVE_FOLDER) ---------- */
    if (path === '/photos') {
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      if (!env.DRIVE_KEY || !env.DRIVE_FOLDER) return json({ error: 'Photos not set up (add DRIVE_KEY and DRIVE_FOLDER secrets)' }, 500);
      try {
        const data = await cached('photos-v1-' + encodeURIComponent(env.DRIVE_FOLDER), 1800, async () => {
          const out = []; let tok = '';
          const q = encodeURIComponent(`'${env.DRIVE_FOLDER}' in parents and mimeType contains 'image/' and trashed=false`);
          for (let i = 0; i < 20; i++) {
            const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&key=${encodeURIComponent(env.DRIVE_KEY)}&fields=nextPageToken,files(id,name)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${tok ? '&pageToken=' + tok : ''}`, { headers: { 'Referer': ALLOWED_ORIGINS[0] + '/' } });   /* matches a key restricted to your site */
            const d = await r.json();
            if (d.error) throw new Error(d.error.message || 'Drive error');
            out.push(...(d.files || []).map(f => ({ id: f.id, name: f.name }))); tok = d.nextPageToken || '';
            if (!tok) break;
          }
          return { files: out };
        });
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Home tech: each Mac POSTs its stats here, the dashboard GETs them: /stats?key=...&names=A,B,C ---------- */
    if (path === '/stats') {
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      const slug = n => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const ck = n => new Request('https://nova-cache.local/stats-v1-' + slug(n));
      /* Workers KV (binding NOVA_KV) is one shared copy for every Cloudflare location; the Cache API is per location,
         so the TV and the Macs could see different copies. Falls back to the cache if the binding isn't set up. */
      const KV = env.NOVA_KV;
      const load = async n => KV ? KV.get('stats-' + slug(n), 'json').catch(() => null)
        : caches.default.match(ck(n)).then(r => r ? r.json() : null).catch(() => null);
      const save = (n, v) => KV ? KV.put('stats-' + slug(n), JSON.stringify(v), { expirationTtl: 1209600 })
        : caches.default.put(ck(n), new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1209600' } }));
      if (request.method === 'POST') {
        const body = await request.text();
        if (body.length > 40000) return json({ error: 'Too big' }, 413);
        let d; try { d = JSON.parse(body); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
        if (!d.name) return json({ error: 'No name' }, 400);
        /* quick ping-only updates keep the last full set of stats */
        const old = await load(d.name) || {};
        /* KV's free plan allows 1,000 saves a day: keep each Mac to one save per ~10 minutes (a manual log like "backed up" always saves) */
        if (KV && !d.manual && old.received && Date.now() - old.received < 9 * 60000) return json({ ok: true, skipped: true, store: 'kv' });
        const merged = { ...old, ...d, received: Date.now() };
        if (d.full) merged.fullAt = Date.now();
        await save(d.name, merged);
        return json({ ok: true, store: KV ? 'kv' : 'cache' });
      }
      const names = String(reqUrl.searchParams.get('names') || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 8);
      const machines = {};
      await Promise.all(names.map(async n => { const m = await load(n); if (m) machines[n] = m; }));
      return json({ machines, now: Date.now(), store: KV ? 'kv' : 'cache' });
    }

    /* ---------- Car status: the kitchen Mac POSTs Hyundai's saved status here, the dashboard GETs it ---------- */
    if (path === '/car') {
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      const ck = new Request('https://nova-cache.local/car-v1');
      if (request.method === 'POST') {
        const body = await request.text();
        if (body.length > 20000) return json({ error: 'Too big' }, 413);
        let d; try { d = JSON.parse(body); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
        /* a sign-in problem keeps the last good numbers and just flags it */
        if (d.needsLogin || (d.error && d.soc == null)) {
          const old = await caches.default.match(ck); const prev = old ? await old.json() : {};
          d = { ...prev, needsLogin: !!d.needsLogin, error: d.error || prev.error || '' };
        } else { d.needsLogin = false; d.error = ''; }
        d.received = new Date().toISOString();
        await caches.default.put(ck, new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=2592000' } }));
        return json({ ok: true });
      }
      const hit = await caches.default.match(ck);
      return hit ? json(await hit.json()) : json({ error: 'No car data yet' });
    }

    if (path === '/local') {
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      if (!env.ON511_KEY) return json({ error: '511 key not set up' }, 500);
      const lat = num(reqUrl.searchParams.get('lat'), 43.13), lon = num(reqUrl.searchParams.get('lon'), -80.75);
      const rad = Math.min(100, num(reqUrl.searchParams.get('r'), 40)), nCams = Math.min(8, Math.max(1, num(reqUrl.searchParams.get('cams'), 4)));
      const k = encodeURIComponent(env.ON511_KEY);
      try {
        const [cams, evs] = await Promise.all([
          cached('511-cams-v1', 3600, () => getJSON(`https://511on.ca/api/v2/get/cameras?key=${k}&format=json&lang=en`)),
          cached('511-events-v1', 120, () => getJSON(`https://511on.ca/api/v2/get/event?key=${k}&format=json&lang=en`)),
        ]);
        /* road = only cameras on that road; match = words that must all be in the camera's name (e.g. "401 towerline"); view = preferred view (e.g. "north") */
        const roadF = String(reqUrl.searchParams.get('road') || '').trim().toLowerCase();
        const words = String(reqUrl.searchParams.get('match') || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
        const viewF = String(reqUrl.searchParams.get('view') || '').trim().toLowerCase();
        const txt = c => ((c.Roadway || '') + ' ' + (c.Location || '') + ' ' + (c.Views || []).map(v => v.Description || '').join(' ')).toLowerCase();
        const shape = c => {
          const views = (c.Views || []).filter(v => v.Url && !/disabled/i.test(v.Status || ''));
          const v = (viewF && views.find(x => String(x.Description || '').toLowerCase().includes(viewF))) || views[0];
          return { loc: c.Location || '', road: c.Roadway || '', dir: v && v.Description ? String(v.Description) : (c.Direction && !/unknown/i.test(c.Direction) ? c.Direction : ''),
            img: v ? v.Url : '', lat: c.Latitude, lon: c.Longitude, dist: Math.round(distKm(lat, lon, c.Latitude, c.Longitude) * 10) / 10 };
        };
        const pickList = f => (cams || []).filter(f).map(shape).filter(c => c.img && isFinite(c.dist)).sort((a, b) => a.dist - b.dist);
        let camList = words.length ? pickList(c => words.every(w => txt(c).includes(w))) : [];
        const matched = camList.length > 0;
        if (!matched) camList = pickList(c => !roadF || txt(c).includes(roadF));
        camList = camList.slice(0, nCams);
        const [elat, elon] = matched && camList[0] ? [camList[0].lat, camList[0].lon] : [lat, lon];
        const rank = { accidentsAndIncidents: 0, closures: 1, roadwork: 2 };
        const events = (evs || []).map(e => ({
          type: e.EventType || '', sub: e.EventSubType || '', road: e.RoadwayName || '', dir: e.DirectionOfTravel && !/unknown/i.test(e.DirectionOfTravel) ? e.DirectionOfTravel : '',
          desc: e.Description || '', lanes: e.LanesAffected || '', full: !!e.IsFullClosure, reported: e.Reported || e.StartDate || 0, ends: e.PlannedEndDate || 0,
          dist: Math.round(distKm(elat, elon, e.Latitude, e.Longitude) * 10) / 10 }))
          .filter(e => isFinite(e.dist) && e.dist <= rad)
          .sort((a, b) => (rank[a.type] ?? 3) - (rank[b.type] ?? 3) || (b.full - a.full) || a.dist - b.dist).slice(0, 8);
        /* winter road conditions near you (Ontario 511, reported by road crews Nov–Apr); only asked for when roads=1 */
        let roads = null, roadKeys = null;
        if (reqUrl.searchParams.get('roads') === '1') {
          try {
            const rc = await cached('511-roads-v1', 600, () => getJSON(`https://511on.ca/api/v2/get/roadconditions?key=${k}&format=json&lang=en`));
            const list = Array.isArray(rc) ? rc : (rc && (rc.Items || rc.items || rc.RoadConditions)) || [];
            roadKeys = list[0] ? Object.keys(list[0]).slice(0, 20) : [];
            /* decode the first point of the stretch's line to know where it is */
            const firstPt = enc => { if (!enc) return null; const str = Array.isArray(enc) ? enc[0] : enc; if (!str) return null; let i = 0; const nxt = () => { let r = 0, sh = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32 && i < str.length); return (r & 1) ? ~(r >> 1) : (r >> 1); };
              const la = nxt() / 1e5, lo = nxt() / 1e5; return isFinite(la) && isFinite(lo) ? [la, lo] : null; };
            const val = v => Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v == null ? '' : v);
            roads = list.map(r => { const pt = firstPt(r.EncodedPolyline || r.Polyline) || (r.Latitude != null ? [r.Latitude, r.Longitude] : null);
              return { road: val(r.RoadwayName || r.Roadway || r.Highway), where: val(r.LocationDescription || r.Description || r.Location),
                cond: val(r['Primary Condition'] || r.PrimaryCondition || r.Condition || r.SurfaceCondition || r.Conditions), more: val(r['Secondary Conditions'] || r.SecondaryConditions),
                vis: val(r.Visibility), drift: /yes/i.test(String(r.Drifting || '')), at: r.LastUpdated || r.LastUpdate || 0, dist: pt ? Math.round(distKm(lat, lon, pt[0], pt[1]) * 10) / 10 : 999 }; })
              .filter(r => r.cond && !/^no report$/i.test(r.cond) && r.dist <= Math.min(rad, 45)).sort((a, b) => a.dist - b.dist).slice(0, 8);
          } catch (e) { roads = []; roadKeys = ['error: ' + String(e.message || e).slice(0, 80)]; }
        }
        return json({ at: Date.now(), cams: camList, matched, events, ...(roads ? { roads, roadKeys } : {}) });
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Planes overhead: /planes?key=...&lat=..&lon=..&r=40 (km) ---------- */
    if (path === '/planes') {
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      const lat = num(reqUrl.searchParams.get('lat'), 43.13), lon = num(reqUrl.searchParams.get('lon'), -80.75);
      const rad = Math.min(150, num(reqUrl.searchParams.get('r'), 40)), nm = Math.ceil(rad / 1.852);
      try {
        const data = await cached(`planes-${lat.toFixed(2)}-${lon.toFixed(2)}-${rad}-v1`, 20, async () => {
          let raw = null;
          for (const u of [`https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${nm}`, `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`]) {
            try { raw = await getJSON(u); if (raw) break; } catch (e) {}
          }
          if (!raw) throw new Error('flight data unavailable');
          const list = (raw.ac || raw.aircraft || []).filter(a => a.lat != null && a.lon != null && a.alt_baro !== 'ground')
            .map(a => ({ cs: String(a.flight || '').trim(), reg: a.r || '', type: a.t || '', desc: a.desc || '', alt: typeof a.alt_baro === 'number' ? a.alt_baro : (a.alt_geom || null),
              kt: a.gs != null ? Math.round(a.gs) : null, trk: a.track != null ? Math.round(a.track) : (a.true_heading != null ? Math.round(a.true_heading) : null),
              vs: a.baro_rate != null ? a.baro_rate : (a.geom_rate != null ? a.geom_rate : 0),
              dist: Math.round(distKm(lat, lon, a.lat, a.lon) * 10) / 10, brg: Math.round(bearing(lat, lon, a.lat, a.lon)) }))
            .filter(a => a.dist <= rad).sort((a, b) => a.dist - b.dist).slice(0, 14);
          await Promise.all(list.slice(0, 8).map(async a => {
            if (!/^[A-Z]{3}\d/.test(a.cs)) return;
            try {
              const j = await getJSON(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(a.cs)}`, { cf: { cacheTtl: 21600, cacheEverything: true } });
              const fr = j && j.response && j.response.flightroute; if (!fr) return;
              a.airline = (fr.airline && fr.airline.name) || '';
              const ap = x => x ? { code: x.iata_code || x.icao_code || '', city: x.municipality || x.name || '' } : null;
              a.from = ap(fr.origin); a.to = ap(fr.destination);
            } catch (e) {}
          }));
          return { at: Date.now(), count: list.length, planes: list };
        });
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Drive time + route to a calendar location: /route?key=...&q=LOCATION ---------- */
    if (path === '/route') {
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      const q = (reqUrl.searchParams.get('q') || '').trim().slice(0, 200);
      if (!q) return json({ error: 'No location' }, 400);
      let [hlat, hlon] = String(env.HOME || '').split(',').map(Number);
      if (!isFinite(hlat) || !isFinite(hlon) || (!hlat && !hlon)) { hlat = num(reqUrl.searchParams.get('lat'), 43.13); hlon = num(reqUrl.searchParams.get('lon'), -80.75); }
      try {
        /* find the place (cached for 30 days once found) */
        const gk = new Request('https://nova-cache.local/geo-v1/' + encodeURIComponent(q.toLowerCase()));
        let geo = null; const gh = await caches.default.match(gk); if (gh) geo = await gh.json();
        if (!geo) {
          try { const j = await getJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${hlat}&lon=${hlon}&limit=1&lang=en`);
            const f = (j.features || [])[0]; if (f) { const p = f.properties || {}; geo = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: [p.name, p.housenumber && p.street ? p.housenumber + ' ' + p.street : p.street, p.city].filter(Boolean).join(', ') }; } } catch (e) {}
          if (!geo) { try { const j = await getJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ca,us&q=${encodeURIComponent(q)}`);
            if (j[0]) geo = { lat: +j[0].lat, lon: +j[0].lon, name: String(j[0].display_name || '').split(',').slice(0, 3).join(',') }; } catch (e) {} }
          if (!geo) return json({ none: true });
          await caches.default.put(gk, new Response(JSON.stringify(geo), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=2592000' } }));
        }
        /* typical driving route (OpenStreetMap routing, no live traffic) */
        const rt = await cached(`rt-v1-${hlat.toFixed(4)},${hlon.toFixed(4)}-${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}`, 21600, async () => {
          const j = await getJSON(`https://router.project-osrm.org/route/v1/driving/${hlon},${hlat};${geo.lon},${geo.lat}?overview=simplified&geometries=geojson`);
          const r = (j.routes || [])[0]; if (!r) return null;
          let pts = (r.geometry && r.geometry.coordinates) || []; const step = Math.max(1, Math.ceil(pts.length / 300));
          pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(p => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
          return { km: Math.round(r.distance / 100) / 10, min: Math.round(r.duration / 60), line: pts };
        });
        if (!rt) return json({ none: true });
        return json({ name: geo.name, lat: geo.lat, lon: geo.lon, from: [hlat, hlon], ...rt });
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- ESPN highlight clips: /highlights?league=nhl|mlb&event=ESPN_EVENT_ID ---------- */
    const espnSport = { nhl: 'hockey/nhl', mlb: 'baseball/mlb' };
    const espnVideos = d => (d.videos || []).map(v => { const s = (v.links && v.links.source) || {};
      const mp4 = (s.HD && s.HD.href) || s.href || (s.mezzanine && s.mezzanine.href) || '';
      return { title: v.headline || v.title || '', mp4, thumb: v.thumbnail || '', dur: v.duration || 0, date: v.lastModified || v.originalPublishDate || '' }; })
      .filter(v => /^https:\/\/.+\.mp4/i.test(v.mp4));
    if (path === '/highlights') {
      const lg = (reqUrl.searchParams.get('league') || 'nhl').toLowerCase(), ev = reqUrl.searchParams.get('event') || '';
      if (!espnSport[lg] || !/^\d+$/.test(ev)) return json({ error: 'Bad request' }, 400);
      try {
        const data = await cached(`hl-${lg}-${ev}-v1`, 60, async () => {
          const d = await getJSON(`https://site.api.espn.com/apis/site/v2/sports/${espnSport[lg]}/summary?event=${ev}`);
          return { videos: espnVideos(d) };
        });
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Morning-after recap (NHL): /recap?team=TOR ---------- */
    if (path === '/recap') {
      const team = (reqUrl.searchParams.get('team') || 'TOR').toUpperCase();
      if (!/^[A-Z]{3}$/.test(team)) return json({ error: 'Bad team' }, 400);
      try {
        const data = await cached(`recap-${team}-v1`, 600, async () => {
          const NHL = 'https://api-web.nhle.com/v1', ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
          const sched = await getJSON(`${NHL}/club-schedule-season/${team}/now`);
          const all = (sched.games || []).filter(g => g.gameType === 2 || g.gameType === 3);
          const done = g => /^(OFF|FINAL)$/.test(g.gameState || '');
          const lg = all.filter(done).pop();
          if (!lg) return { none: true };
          const [land, box, espnSched] = await Promise.all([getJSON(`${NHL}/gamecenter/${lg.id}/landing`).catch(() => ({})), getJSON(`${NHL}/gamecenter/${lg.id}/boxscore`).catch(() => ({})),
            getJSON(`${ESPN}/hockey/nhl/teams/${team.toLowerCase()}/schedule`).catch(() => ({ events: [] }))]);
          const home = lg.homeTeam.abbrev === team, ME = home ? lg.homeTeam : lg.awayTeam, OP = home ? lg.awayTeam : lg.homeTeam;
          const nmT = T => (T.commonName && T.commonName.default) || (T.placeName && T.placeName.default) || T.abbrev;
          const bH = box.homeTeam || {}, bA = box.awayTeam || {}, sum = land.summary || {};
          const perName = pd => !pd ? '' : pd.periodType === 'SO' ? 'SO' : pd.periodType === 'OT' ? 'OT' : ['1st', '2nd', '3rd'][pd.number - 1] || pd.number + 'th';
          const nm = p => (p.name && p.name.default) || [p.firstName && p.firstName.default, p.lastName && p.lastName.default].filter(Boolean).join(' ');
          const goals = [];
          (sum.scoring || []).forEach(per => (per.goals || []).forEach(g => { const ab = (g.teamAbbrev && g.teamAbbrev.default) || g.teamAbbrev || '';
            goals.push({ per: perName(per.periodDescriptor), time: g.timeInPeriod || '', us: ab === team, team: ab, scorer: nm(g), n: g.goalsToDate || null, img: g.headshot || '',
              assists: (g.assists || []).map(a => nm(a)), strength: String(g.strength || '').toUpperCase(), score: home ? `${g.homeScore}-${g.awayScore}` : `${g.awayScore}-${g.homeScore}` }); }));
          const shotsBy = (sum.shotsByPeriod || []).map(s => ({ p: perName(s.periodDescriptor), us: home ? s.home : s.away, them: home ? s.away : s.home }));
          const goalsBy = (sum.scoring || []).map(per => { const p = perName(per.periodDescriptor), gs = per.goals || [];
            return { p, us: gs.filter(g => ((g.teamAbbrev && g.teamAbbrev.default) || g.teamAbbrev) === team).length, them: gs.filter(g => ((g.teamAbbrev && g.teamAbbrev.default) || g.teamAbbrev) !== team).length }; });
          const stars = (sum.threeStars || []).sort((a, b) => (a.star || 0) - (b.star || 0)).map(s => ({ star: s.star, name: nm(s), team: s.teamAbbrev && s.teamAbbrev.default ? s.teamAbbrev.default : s.teamAbbrev || '', img: s.headshot || '',
            line: s.position === 'G' ? (s.savePctg != null ? Number(s.savePctg).toFixed(3).replace(/^0/, '') + ' SV%' : 'Goalie') : [s.goals ? s.goals + 'G' : '', s.assists ? s.assists + 'A' : ''].filter(Boolean).join(' ') || (s.points ? s.points + ' PTS' : '') }));
          const pbg = box.playerByGameStats || {};
          const goalie = tm => { const g = ((tm || {}).goalies || []).filter(x => x.toi && x.toi !== '00:00').sort((a, b) => (b.toi > a.toi ? 1 : -1))[0]; if (!g) return null;
            const m = String(g.saveShotsAgainst || '').match(/(\d+)\/(\d+)/); return { name: (g.name && g.name.default) || '', saves: m ? +m[1] : 0, shots: m ? +m[2] : 0, sv: g.savePctg != null ? Number(g.savePctg).toFixed(3).replace(/^0/, '') : '' }; };
          const evs = (espnSched.events || []).filter(e => { const s = ((e.competitions || [])[0] || {}).status || {}; return s.type && s.type.completed; });
          const le = evs[evs.length - 1];
          const videos = le && Math.abs(Date.parse(le.date) - Date.parse(lg.startTimeUTC)) < 12 * 3600e3 ? espnVideos(await getJSON(`${ESPN}/hockey/nhl/summary?event=${le.id}`).catch(() => ({}))).slice(0, 6) : [];
          const nx = all.find(g => !done(g) && Date.parse(g.startTimeUTC) > Date.now() - 3600e3);
          const ot = /OT|SO/.test((lg.gameOutcome && lg.gameOutcome.lastPeriodType) || '');
          return { league: 'NHL', id: lg.id, date: lg.startTimeUTC, home, ot, otType: (lg.gameOutcome && lg.gameOutcome.lastPeriodType) || '',
            us: { abbr: ME.abbrev, name: nmT(ME), logo: ME.darkLogo || ME.logo || '', score: ME.score, sog: home ? bH.sog : bA.sog },
            them: { abbr: OP.abbrev, name: nmT(OP), logo: OP.darkLogo || OP.logo || '', score: OP.score, sog: home ? bA.sog : bH.sog },
            win: ME.score > OP.score, goals, shotsBy, goalsBy, stars, goalies: { us: goalie(home ? pbg.homeTeam : pbg.awayTeam), them: goalie(home ? pbg.awayTeam : pbg.homeTeam) },
            videos, next: nx ? { start: nx.startTimeUTC, home: nx.homeTeam.abbrev === team, opp: nx.homeTeam.abbrev === team ? nx.awayTeam.abbrev : nx.homeTeam.abbrev } : null };
        });
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Hockey hub: /hub?team=TOR&mlb=141 ---------- */
    if (path === '/hub') {
      const team = (reqUrl.searchParams.get('team') || 'TOR').toUpperCase(), mlbId = parseInt(reqUrl.searchParams.get('mlb') || '141', 10);
      if (!/^[A-Z]{3}$/.test(team)) return json({ error: 'Bad team' }, 400);
      try {
        const data = await cached(`hub-${team}-${mlbId}-v3`, 600, async () => {
          const NHL = 'https://api-web.nhle.com/v1', ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
          const pad2 = n => String(n).padStart(2, '0'), ymd = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
          const [sched, stand, stats, espnSched, espnTx, espnInj, mlbTx] = await Promise.all([
            getJSON(`${NHL}/club-schedule-season/${team}/now`).catch(() => ({ games: [] })),
            getJSON(`${NHL}/standings/now`).catch(() => ({ standings: [] })),
            getJSON(`${NHL}/club-stats/${team}/now`).catch(() => ({})),
            getJSON(`${ESPN}/hockey/nhl/teams/${team.toLowerCase()}/schedule`).catch(() => ({ events: [] })),
            getJSON(`${ESPN}/hockey/nhl/transactions`).catch(() => ({})),
            getJSON(`${ESPN}/hockey/nhl/injuries`).catch(() => ({})),
            mlbId > 0 ? getJSON(`https://statsapi.mlb.com/api/v1/transactions?teamId=${mlbId}&startDate=${ymd(new Date(Date.now() - 45 * 864e5))}&endDate=${ymd(new Date())}`).catch(() => ({})) : {},
          ]);
          const done = g => /^(OFF|FINAL)$/.test(g.gameState || '');
          const all = (sched.games || []).filter(g => g.gameType === 2 || g.gameType === 3);
          const reg = all.filter(g => g.gameType === 2);
          const st = stand.standings || [], mine = st.find(s => s.teamAbbrev && s.teamAbbrev.default === team) || {};
          const gp = mine.gamesPlayed || 0, totalGames = reg.length || 82;
          const SHORT = { SN: 'Sportsnet', SNO: 'SN Ontario', SN1: 'SN One', SNE: 'SN East', SNW: 'SN West', SNP: 'SN Pacific', SN360: 'SN 360', CBC: 'CBC', TSN: 'TSN', TSN1: 'TSN1', TSN2: 'TSN2', TSN3: 'TSN3', TSN4: 'TSN4', TSN5: 'TSN5', TVAS: 'TVA Sports', TVAS2: 'TVA Sports 2', CITY: 'Citytv', PRIME: 'Prime Video', 'SN+': 'Sportsnet+' };
          /* next 5 games */
          const next = all.filter(g => !done(g) && Date.parse(g.startTimeUTC) > Date.now() - 4 * 3600e3).slice(0, 5).map(g => {
            const home = g.homeTeam.abbrev === team, op = home ? g.awayTeam : g.homeTeam;
            return { start: g.startTimeUTC, home, opp: op.abbrev, logo: op.darkLogo || op.logo || '', live: /^(LIVE|CRIT)$/.test(g.gameState || ''),
              nets: [...new Set((g.tvBroadcasts || []).filter(b => b.countryCode === 'CA').map(b => SHORT[b.network] || b.network))] };
          });
          /* last game: score, shots, power play, three stars */
          const lg = all.filter(done).pop();
          let last = null;
          if (lg) {
            const [land, box] = await Promise.all([getJSON(`${NHL}/gamecenter/${lg.id}/landing`).catch(() => ({})), getJSON(`${NHL}/gamecenter/${lg.id}/boxscore`).catch(() => ({}))]);
            const home = lg.homeTeam.abbrev === team, me = home ? lg.homeTeam : lg.awayTeam, op = home ? lg.awayTeam : lg.homeTeam;
            const ot = /OT|SO/.test((lg.gameOutcome && lg.gameOutcome.lastPeriodType) || '');
            const bH = box.homeTeam || {}, bA = box.awayTeam || {}, sum = land.summary || {};
            const tgs = (sum.teamGameStats || []).reduce((o, x) => { o[x.category] = x; return o; }, {});
            const pp = tgs.powerPlay ? (home ? tgs.powerPlay.homeValue : tgs.powerPlay.awayValue) : '';
            const nm = p => (p.name && p.name.default) || [p.firstName && p.firstName.default, p.lastName && p.lastName.default].filter(Boolean).join(' ');
            const stars = (sum.threeStars || []).sort((a, b) => (a.star || 0) - (b.star || 0)).map(s => ({ star: s.star, name: nm(s), team: s.teamAbbrev && s.teamAbbrev.default ? s.teamAbbrev.default : s.teamAbbrev || '', img: s.headshot || '',
              line: s.position === 'G' ? (s.savePctg != null ? Number(s.savePctg).toFixed(3).replace(/^0/, '') + ' SV%' : 'Goalie') : [s.goals ? s.goals + 'G' : '', s.assists ? s.assists + 'A' : ''].filter(Boolean).join(' ') || (s.points ? s.points + ' PTS' : '') }));
            last = { date: lg.startTimeUTC, opp: op.abbrev, home, us: me.score, them: op.score, res: me.score > op.score ? 'W' : ot ? 'OTL' : 'L', ot,
              sog: [home ? bH.sog : bA.sog, home ? bA.sog : bH.sog], pp, stars };
          }
          /* team leaders */
          const sk = stats.skaters || [], gk = (stats.goalies || []).slice().sort((a, b) => (b.gamesPlayed || 0) - (a.gamesPlayed || 0));
          const pn = p => [p.firstName && p.firstName.default, p.lastName && p.lastName.default].filter(Boolean).join(' ');
          const top = k => { const p = sk.slice().sort((a, b) => (b[k] || 0) - (a[k] || 0) || (b.points || 0) - (a.points || 0))[0]; return p ? { name: pn(p), v: p[k] || 0, img: p.headshot || '' } : null; };
          const leaders = { points: top('points'), goals: top('goals'), assists: top('assists'),
            save: gk[0] ? { name: pn(gk[0]), v: gk[0].savePercentage != null ? Number(gk[0].savePercentage).toFixed(3).replace(/^0/, '') : '', img: gk[0].headshot || '' } : null };
          /* league ranks (NHL stats) */
          let ranks = null;
          try {
            const season = sched.currentSeason || mine.seasonId || '';
            const ts = await getJSON(`https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=${encodeURIComponent('seasonId=' + season + ' and gameTypeId=2')}`);
            const rows = ts.data || [], full = (mine.teamName && mine.teamName.default) || '';
            const me = rows.find(r => r.teamFullName === full);
            if (me) { const rk = (k, asc) => rows.slice().sort((a, b) => asc ? a[k] - b[k] : b[k] - a[k]).findIndex(r => r === me) + 1;
              ranks = { pp: [Math.round(me.powerPlayPct * 1000) / 10, rk('powerPlayPct')], pk: [Math.round(me.penaltyKillPct * 1000) / 10, rk('penaltyKillPct')],
                gf: [Math.round(me.goalsForPerGame * 100) / 100, rk('goalsForPerGame')], ga: [Math.round(me.goalsAgainstPerGame * 100) / 100, rk('goalsAgainstPerGame', true)], of: rows.length }; }
          } catch (e) {}
          /* playoff race */
          const conf = st.filter(s => s.conferenceAbbrev === mine.conferenceAbbrev).sort((a, b) => b.points - a.points || a.gamesPlayed - b.gamesPlayed);
          const div = st.filter(s => s.divisionAbbrev === mine.divisionAbbrev).sort((a, b) => b.points - a.points || a.gamesPlayed - b.gamesPlayed);
          const ci = conf.indexOf(mine), inSpot = ci > -1 && ci < 8;
          const race = { behindFirst: div[0] ? div[0].points - (mine.points || 0) : 0, leader: div[0] && div[0].teamAbbrev ? div[0].teamAbbrev.default : '',
            line: inSpot ? (mine.points || 0) - (conf[8] ? conf[8].points : 0) : (mine.points || 0) - (conf[7] ? conf[7].points : 0), inSpot,
            pace: gp ? Math.round((mine.points || 0) / gp * totalGames) : null };
          /* highlight clips from the last game (ESPN) */
          const evs = (espnSched.events || []).filter(e => { const s = ((e.competitions || [])[0] || {}).status || {}; return s.type && s.type.completed; });
          const le = evs[evs.length - 1];
          const videos = le ? espnVideos(await getJSON(`${ESPN}/hockey/nhl/summary?event=${le.id}`).catch(() => ({}))).slice(0, 6) : [];
          /* roster moves + injuries */
          const moves = [];
          const espnList = j => { const out = []; (function walk(n) { if (Array.isArray(n)) return n.forEach(walk); if (!n || typeof n !== 'object') return;
            if (typeof n.description === 'string' && (n.date || n.transactionDate)) out.push(n); else Object.values(n).forEach(walk); })(j); return out; };
          espnList(espnTx).filter(t => { const tm = t.team || {}; return (tm.abbreviation || '').toUpperCase() === team || /maple leafs/i.test(tm.displayName || ''); })
            .slice(0, 8).forEach(t => moves.push({ lg: 'NHL', date: t.date || t.transactionDate, text: t.description }));
          ((mlbTx.transactions || []).filter(t => t.description)).slice(-8).reverse().forEach(t => moves.push({ lg: 'MLB', date: t.date || t.effectiveDate, text: t.description }));
          moves.sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
          const injuries = [];
          (espnInj.injuries || []).forEach(t => { const tn = t.displayName || (t.team && t.team.displayName) || '';
            if (!/maple leafs/i.test(tn) && !((t.team || {}).abbreviation === team)) return;
            (t.injuries || []).forEach(i => injuries.push({ name: (i.athlete && i.athlete.displayName) || '', status: i.status || '', note: i.shortComment ? String(i.shortComment).slice(0, 80) : ((i.details && i.details.type) || '') })); });
          let news = [];
          try {
            const pick = j => (j.articles || []).filter(a => a.headline && a.type !== 'Media').map(a => ({ title: a.headline, desc: a.description || '', date: a.published || a.lastModified || '',
              img: ((a.images || [])[0] || {}).url || '', by: a.byline || '', team: (a.categories || []).some(c => c.type === 'team' && (c.teamId === 21 || /maple leafs/i.test(c.description || ''))) || /maple leafs|leafs/i.test(a.headline + ' ' + (a.description || '')) }));
            let arts = pick(await getJSON(`${ESPN}/hockey/nhl/news?team=21&limit=15`).catch(() => ({})));
            if (!arts.some(a => a.team)) arts = pick(await getJSON(`${ESPN}/hockey/nhl/news?limit=50`).catch(() => ({})));
            news = arts.filter(a => a.team).sort((x, y) => Date.parse(y.date || 0) - Date.parse(x.date || 0)).slice(0, 6).map(({ team, ...r }) => r);
          } catch (e) {}
          return { news, team, name: (mine.teamCommonName && mine.teamCommonName.default) || 'Maple Leafs', logo: mine.teamLogo || '',
            record: gp ? `${mine.wins}-${mine.losses}-${mine.otLosses}` : '0-0-0', pts: mine.points || 0, gp,
            divRank: mine.divisionSequence || null, divName: mine.divisionName || '', confRank: mine.conferenceSequence || null, confName: mine.conferenceName || '',
            streak: mine.streakCode ? mine.streakCode + (mine.streakCount || '') : '', l10: mine.l10Wins != null ? `${mine.l10Wins}-${mine.l10Losses}-${mine.l10OtLosses}` : '',
            next, last, leaders, ranks, race, videos, moves: moves.slice(0, 8), injuries: injuries.slice(0, 6) };
        });
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* the same show/movie can live in two libraries (e.g. a kids library of symlinks): count by title, not by Jellyfin id */
    const titleKey = (name, year) => String(name || '').toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim() + (year ? '|' + year : '');

    /* ---------- Watch next: /jellyfin/picks?key=...&users=Name1,Name2  (only from your own library) ---------- */
    if (path === '/jellyfin/picks') {
      if (!env.JF_URL || !env.JF_KEY) return json({ error: 'Jellyfin not set up' }, 500);
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      const want = String(reqUrl.searchParams.get('users') || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).slice(0, 4);
      try {
        const data = await cached('jfpicks-v6-' + encodeURIComponent(String(reqUrl.searchParams.get('lib') || 'Movies').toLowerCase()) + '-' + encodeURIComponent(want.join(',')), 1800, async () => {
          const base = env.JF_URL.replace(/\/+$/, ''), jfh = { 'Authorization': `MediaBrowser Token="${env.JF_KEY}"`, 'Accept': 'application/json' };
          const get = p => getJSON(base + p, { headers: jfh });
          const hex = v => String(v || '').replace(/-/g, '');
          const all = await get('/Users');
          const users = want.map(w => (all || []).find(u => String(u.Name || '').toLowerCase() === w) || (all || []).find(u => String(u.Name || '').toLowerCase().startsWith(w))).filter(Boolean);
          if (!users.length) return { error: 'Users not found on Jellyfin: ' + want.join(', ') };
          const F = 'Fields=Overview,Genres,CommunityRating,RunTimeTicks,ProductionYear,ChildCount,DateCreated,SeriesId&enableImages=false&EnableTotalRecordCount=false';
          /* movies only from the "Movies" library (other libraries like Children's Movies are symlinks to the same films) */
          const libName = String(reqUrl.searchParams.get('lib') || 'Movies').toLowerCase();
          const views = await get(`/Users/${users[0].Id}/Views`).then(r => r.Items || []).catch(() => []);
          const movLib = (views.find(v => String(v.Name || '').toLowerCase() === libName) || views.find(v => v.CollectionType === 'movies') || {}).Id || '';
          const inLib = movLib ? '&ParentId=' + movLib : '';
          const dedupe = list => { const seen = new Set(); return list.filter(m => { const k = String(m.Name || '').toLowerCase() + '|' + (m.ProductionYear || ''); if (seen.has(k)) return false; seen.add(k); return true; }); };
          const per = {};
          await Promise.all(users.map(async u => {
            const q = (t, f, extra) => get(`/Users/${u.Id}/Items?Recursive=true&IncludeItemTypes=${t}${f ? '&Filters=' + f : ''}${extra || ''}&${F}&limit=20000`).then(r => r.Items || []).catch(() => []);
            const [movRaw, eps, ser, part] = await Promise.all([q('Movie', '', inLib), q('Episode', 'IsPlayed'), q('Series'), q('Episode', 'IsResumable')]);
            const mov = dedupe(movRaw);
            /* a show counts as started if any episode is watched or partly watched */
            const started = new Set([...eps, ...part].map(e => hex(e.SeriesId)).filter(Boolean));
            per[u.Name] = { mov, eps, ser, started };
          }));
          const names = users.map(u => u.Name);
          /* what each person has watched most: shows by episodes watched (rewatches count), movies by times watched */
          const tally = {}, mine = {};
          names.forEach(n => {
            const t = mine[n] = {};
            per[n].eps.forEach(e => { if (!e.SeriesId && !e.SeriesName) return; const k = 's:' + titleKey(e.SeriesName) ; const c = Math.max(1, (e.UserData || {}).PlayCount || 0);
              (t[k] = t[k] || { id: hex(e.SeriesId), title: e.SeriesName || '', type: 'Series', plays: 0 }).plays += c; });
            per[n].mov.forEach(m => { const ud = m.UserData || {}; if (!ud.Played && !ud.PlayCount) return; const k = 'm:' + titleKey(m.Name, m.ProductionYear);
              const c = Math.max(1, ud.PlayCount || 0); if (t[k]) t[k].plays += c; else t[k] = { id: hex(m.Id), title: m.Name || '', type: 'Movie', plays: c }; });
            Object.entries(t).forEach(([k, x]) => { (tally[k] = tally[k] || { ...x, plays: 0 }).plays += x.plays; });
          });
          const top = (o, n) => Object.values(o).filter(x => x.title).sort((a, b) => b.plays - a.plays).slice(0, n);
          /* picks: movies nobody has watched; shows nobody (or only one of you) has started */
          const first = per[names[0]];
          const playedBy = id => names.filter(n => { if (per[n].started.has(hex(id))) return true;
            const m = per[n].mov.find(x => x.Id === id) || per[n].ser.find(x => x.Id === id); const ud = (m || {}).UserData || {};
            return ud.Played || (ud.PlayCount || 0) > 0 || (ud.PlayedPercentage || 0) > 0 || (ud.PlaybackPositionTicks || 0) > 0; });
          const rt = t => { const m = Math.round((t || 0) / 6e8); return m ? (m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min') : ''; };
          const shape = (it, type, why) => ({ id: hex(it.Id), title: it.Name || '', type, year: it.ProductionYear || '', runtime: rt(it.RunTimeTicks), seasons: type === 'Series' ? (it.ChildCount || 0) : 0,
            rating: it.CommunityRating ? Math.round(it.CommunityRating * 10) / 10 : null, genres: (it.Genres || []).slice(0, 3), overview: String(it.Overview || '').slice(0, 420), why });
          const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
          const good = it => (it.CommunityRating || 7) >= 6.3 && it.Overview;
          const movies = shuffle(first.mov.filter(m => good(m) && !playedBy(m.Id).length)).slice(0, 8).map(m => shape(m, 'Movie', names.length > 1 ? 'Neither of you has watched it' : 'You haven\'t watched it'));
          const shows = shuffle(first.ser.filter(good).map(sr => ({ sr, by: playedBy(sr.Id) })).filter(x => x.by.length < names.length))
            .sort((a, b) => b.by.length - a.by.length).slice(0, 6)
            .map(x => shape(x.sr, 'Series', x.by.length ? `${x.by[0]} started it · ${names.filter(n => !x.by.includes(n)).join(' & ')} hasn't` : (names.length > 1 ? 'Neither of you has started it' : 'You haven\'t started it')));
          shuffle(shows);
          const picks = [];
          for (let i = 0; i < Math.max(movies.length, shows.length); i++) { if (movies[i]) picks.push(movies[i]); if (shows[i]) picks.push(shows[i]); }
          /* newest additions: episodes are grouped by show */
          const latest = await get(`/Items?Recursive=true&IncludeItemTypes=Movie${inLib}&SortBy=DateCreated&SortOrder=Descending&Fields=DateCreated,PremiereDate,ProductionYear,SeriesId,ParentIndexNumber,IndexNumber&enableImages=false&limit=40`).then(r => r.Items || []).catch(() => []);
          const fresh = [], seenF = {}, DAY = 864e5, now = Date.now(), age = d => now - Date.parse(d || 0);
          /* Jellyfin's "date added" moves when the server rescans, so: movies added in the last 30 days;
             episodes only if the whole show is new (30 days) or the episode itself aired in the last 60 days */
          const serAdded = Object.fromEntries(first.ser.map(x => [hex(x.Id), x.DateCreated]));
          for (const it of dedupe(latest)) {
            if (age(it.DateCreated) > 30 * DAY) break;
            if (it.Type === 'Episode') {
              const k = hex(it.SeriesId); if (!k) continue;
              if (!(age(serAdded[k]) <= 30 * DAY || age(it.PremiereDate) <= 60 * DAY)) continue;
              if (seenF[k]) { seenF[k].n++; seenF[k].ep = seenF[k].n + ' new episodes'; continue; }
              const f = seenF[k] = { id: k, title: it.SeriesName || '', type: 'Series', added: it.DateCreated, n: 1, ep: `S${it.ParentIndexNumber || 1}E${it.IndexNumber || '?'}` }; fresh.push(f);
            } else fresh.push({ id: hex(it.Id), title: it.Name || '', type: 'Movie', added: it.DateCreated });
            if (fresh.length >= 5 && !latest.slice(latest.indexOf(it) + 1, latest.indexOf(it) + 3).some(x => seenF[hex(x.SeriesId)])) break;
          }
          return { users: Object.fromEntries(names.map(n => [n, top(mine[n], 3)])), popular: top(tally, 10), picks: picks.slice(0, 12), fresh: fresh.slice(0, 5).map(({ n, ...f }) => f) };
        });
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Jellyfin Wrapped: /jellyfin/wrapped?key=...&from=ISO_DATE ---------- */
    if (path === '/jellyfin/wrapped') {
      if (!env.JF_URL || !env.JF_KEY) return json({ error: 'Jellyfin not set up' }, 500);
      if (!keyOk()) return json({ error: 'Forbidden' }, 403);
      const from = reqUrl.searchParams.get('from') || '';
      if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(from)) return json({ error: 'Bad date' }, 400);
      try {
        const data = await cached('jfwrap-' + from + '-v2', 900, async () => {
          const base = env.JF_URL.replace(/\/+$/, ''), jfh = { 'Authorization': `MediaBrowser Token="${env.JF_KEY}"` };
          const log = await getJSON(`${base}/System/ActivityLog/Entries?minDate=${encodeURIComponent(from)}&limit=5000`, { headers: jfh });
          const hex = v => (typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v.replace(/-/g, ''))) ? v.replace(/-/g, '') : '';
          const plays = [];
          (log.Items || []).forEach(e => { if (!/VideoPlaybackStopped$/i.test(e.Type || '')) return;
            const m = String(e.Name || '').match(/^(.+?) has finished playing (.+?) on (.+)$/i);
            plays.push({ user: m ? m[1] : 'Someone', item: hex(e.ItemId || ''), text: m ? m[2] : '', date: e.Date }); });
          const ids = [...new Set(plays.map(p => p.item).filter(Boolean))];
          const info = {};
          for (let i = 0; i < ids.length; i += 80) {
            const r = await getJSON(`${base}/Items?ids=${ids.slice(i, i + 80).join(',')}&enableImages=false`, { headers: jfh }).catch(() => ({ Items: [] }));
            (r.Items || []).forEach(it => { info[hex(it.Id)] = it; });
          }
          const users = {}, shows = {}, movies = {}, days = [0, 0, 0, 0, 0, 0, 0];
          let hours = 0, late = 0;
          plays.forEach(p => {
            const it = info[p.item] || {}, h = it.RunTimeTicks ? it.RunTimeTicks / 36e9 : 0.75;
            hours += h; const u = users[p.user] || (users[p.user] = { name: p.user, plays: 0, hours: 0 }); u.plays++; u.hours += h;
            const d = new Date(p.date); if (!isNaN(d)) { const loc = new Date(d.getTime() - 4 * 3600e3); days[loc.getUTCDay()]++; const hr = loc.getUTCHours(); if (hr >= 23 || hr < 4) late++; }
            if (it.Type === 'Episode') { const k = titleKey(it.SeriesName) || hex(it.SeriesId || ''); const s = shows[k] || (shows[k] = { title: it.SeriesName || p.text, plays: 0, hours: 0, poster: hex(it.SeriesId || '') }); s.plays++; s.hours += h; }
            else if (it.Type === 'Movie') { const k = titleKey(it.Name, it.ProductionYear) || p.item; const s = movies[k] || (movies[k] = { title: it.Name || p.text, year: it.ProductionYear || '', plays: 0, poster: p.item }); s.plays++; }
          });
          const r1 = x => Math.round(x * 10) / 10;
          return { from, plays: plays.length, hours: r1(hours), late, busiestDay: days.indexOf(Math.max(...days)), days,
            users: Object.values(users).map(u => ({ ...u, hours: r1(u.hours) })).sort((a, b) => b.hours - a.hours),
            shows: Object.values(shows).map(s => ({ ...s, hours: r1(s.hours) })).sort((a, b) => b.plays - a.plays).slice(0, 5),
            movies: Object.values(movies).sort((a, b) => b.plays - a.plays).slice(0, 5) };
        });
        /* All-time totals from every user's play counts (rewatches count), cached 3 hours */
        const all = await cached('jfall-v2', 10800, async () => {
          const base = env.JF_URL.replace(/\/+$/, ''), jfh = { 'Authorization': `MediaBrowser Token="${env.JF_KEY}"` };
          const hex = v => (typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v.replace(/-/g, ''))) ? v.replace(/-/g, '') : '';
          const us = await getJSON(`${base}/Users`, { headers: jfh });
          const shows = {}, movies = {};
          for (const u of (us || []).slice(0, 12)) {
            const q = t => getJSON(`${base}/Users/${u.Id}/Items?Recursive=true&IncludeItemTypes=${t}&Filters=IsPlayed&Fields=ProductionYear&enableImages=false&EnableTotalRecordCount=false&limit=50000`, { headers: jfh }).catch(() => ({ Items: [] }));
            const [ep, mv] = await Promise.all([q('Episode'), q('Movie')]);
            (ep.Items || []).forEach(it => { const n = Math.max(1, (it.UserData || {}).PlayCount || 0), k = titleKey(it.SeriesName) || hex(it.SeriesId || ''); if (!k) return;
              const s = shows[k] || (shows[k] = { title: it.SeriesName || '', plays: 0, poster: hex(it.SeriesId || '') }); s.plays += n; });
            (mv.Items || []).forEach(it => { const n = Math.max(1, (it.UserData || {}).PlayCount || 0), k = titleKey(it.Name, it.ProductionYear) || hex(it.Id);
              const s = movies[k] || (movies[k] = { title: it.Name || '', year: it.ProductionYear || '', plays: 0, poster: hex(it.Id) }); s.plays += n; });
          }
          const top = o => Object.values(o).sort((a, b) => b.plays - a.plays).slice(0, 5);
          return { shows: top(shows), movies: top(movies) };
        }).catch(() => null);
        if (all) data.all = all;
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- MLB game feed, trimmed to what the live pages show ---------- */
    const MLBAPI = 'https://statsapi.mlb.com/api';
    async function mlbFeed(pk) {
      const MLB = MLBAPI;
      const f = await getJSON(`${MLB}/v1.1/game/${pk}/feed/live`);
      const gd = f.gameData || {}, ld = f.liveData || {}, ls = ld.linescore || {}, bx = (ld.boxscore || {}).teams || {};
      const tm = (s) => { const T = (gd.teams || {})[s] || {}, L = (ls.teams || {})[s] || {};
        return { s: s === 'home' ? 'h' : 'a', id: T.id, abbr: T.abbreviation || '', name: T.teamName || T.name || '', logo: T.id ? `https://www.mlbstatic.com/team-logos/${T.id}.svg` : '', runs: L.runs || 0, hits: L.hits || 0, errors: L.errors || 0 }; };
      const away = tm('away'), home = tm('home');
      const pl = (s, id) => (((bx[s] || {}).players || {})['ID' + id]) || {};
      const cur = (ld.plays || {}).currentPlay || {}, mu = cur.matchup || {};
      const top = ls.isTopInning !== false;
      const bat = mu.batter || {}, pit = mu.pitcher || {};
      const bP = pl(top ? 'away' : 'home', bat.id), pP = pl(top ? 'home' : 'away', pit.id);
      const bs = (bP.stats || {}).batting || {}, ps = (pP.stats || {}).pitching || {};
      const shot = id => id ? `https://img.mlbstatic.com/mlb-photos/image/upload/w_200,q_auto:best/v1/people/${id}/headshot/silo/current` : '';
      let zt = 3.4, zb = 1.6;
      const pitches = (cur.playEvents || []).filter(e => e.isPitch).map((e, i) => { const pd = e.pitchData || {}, c = pd.coordinates || {};
        if (pd.strikeZoneTop) { zt = pd.strikeZoneTop; zb = pd.strikeZoneBottom; }
        const code = ((e.details || {}).call || {}).code || '', desc = ((e.details || {}).call || {}).description || (e.details || {}).description || '';
        return { n: e.pitchNumber || i + 1, x: c.pX, z: c.pZ, call: /^[BIPV]$/.test(code) || /ball/i.test(desc) ? 'B' : /^[XDE]$/.test(code) || /in play/i.test(desc) ? 'X' : 'S',
          desc, type: (((e.details || {}).type) || {}).description || '', mph: pd.startSpeed ? Math.round(pd.startSpeed) : null }; });
      const all = (ld.plays || {}).allPlays || [];
      /* current pitcher's pitch mix this game */
      const mixC = {};
      all.forEach(p => { if (((p.matchup || {}).pitcher || {}).id !== pit.id) return;
        (p.playEvents || []).forEach(e => { if (!e.isPitch) return; const t = (((e.details || {}).type) || {}).description || 'Other';
          const m = mixC[t] || (mixC[t] = { type: t, n: 0, v: 0, c: 0 }); m.n++; const sp = (e.pitchData || {}).startSpeed; if (sp) { m.v += sp; m.c++; } }); });
      const mixTot = Object.values(mixC).reduce((s, m) => s + m.n, 0) || 1;
      const mix = Object.values(mixC).sort((x, y) => y.n - x.n).slice(0, 5).map(m => ({ type: m.type, pct: Math.round(m.n / mixTot * 100), mph: m.c ? Math.round(m.v / m.c) : null }));
      const hits = [];
      all.forEach(p => { const ev = (p.playEvents || []).filter(e => e.hitData && e.hitData.coordinates && e.hitData.coordinates.coordX != null).pop(); if (!ev) return;
        const r = (p.result || {}).eventType || '', isHit = /single|double|triple|home_run/.test(r);
        hits.push({ x: ev.hitData.coordinates.coordX, y: ev.hitData.coordinates.coordY, res: r === 'home_run' ? 'HR' : isHit ? 'hit' : 'out', s: (p.about || {}).isTopInning ? 'a' : 'h' }); });
      const feed = all.filter(p => p.result && p.result.description).slice(-10).reverse().map(p => ({ when: ((p.about || {}).isTopInning ? '▲ ' : '▼ ') + ((p.about || {}).inning || ''),
        text: p.result.description, goal: (p.result.rbi || 0) > 0 || p.result.eventType === 'home_run' }));
      const off = ls.offense || {}, pp = gd.probablePitchers || {};
      const st = (gd.status || {}).abstractGameState === 'Live' ? 'live' : (gd.status || {}).abstractGameState === 'Final' ? 'final' : 'pre';
      const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
      return { sport: 'baseball', league: 'MLB', id: pk, state: st, detail: (gd.status || {}).detailedState || '', start: (gd.datetime || {}).dateTime,
        inning: ls.currentInning ? (top ? '▲ ' : '▼ ') + ord(ls.currentInning).toUpperCase() : '', top, outs: ls.outs || 0, balls: ls.balls || 0, strikes: ls.strikes || 0,
        bases: [!!off.first, !!off.second, !!off.third], away, home,
        innings: (ls.innings || []).map(i => ({ n: i.num, a: (i.away || {}).runs, h: (i.home || {}).runs })),
        batter: bat.id ? { name: bat.fullName || '', line: bs.atBats != null ? `${bs.hits || 0}-${bs.atBats}` : '', avg: ((bP.seasonStats || {}).batting || {}).avg || '', img: shot(bat.id) } : null,
        pitcher: pit.id ? { name: pit.fullName || '', pitches: ps.numberOfPitches || ps.pitchesThrown || 0, strikes: ps.strikes || 0, k: ps.strikeOuts || 0, ip: ps.inningsPitched || '0.0', h: ps.hits || 0, r: ps.runs || 0, er: ps.earnedRuns || 0, bb: ps.baseOnBalls || 0, era: ((pP.seasonStats || {}).pitching || {}).era || '', img: shot(pit.id), mix } : null,
        runners: [off.first ? off.first.fullName : '', off.second ? off.second.fullName : '', off.third ? off.third.fullName : ''], onDeck: off.onDeck ? off.onDeck.fullName : '',
        probable: { a: pp.away ? pp.away.fullName : '', h: pp.home ? pp.home.fullName : '' }, venue: (gd.venue || {}).name || '',
        zone: { top: zt, bot: zb }, pitches, hits, feed };
    }

    /* ---------- World Series: /ws ---------- */
    if (path === '/ws') {
      try {
        const data = await cached('ws-v4', 10, async () => {
          const yr = new Date(Date.now() - 5 * 3600e3).getUTCFullYear();
          const sch = await getJSON(`${MLBAPI}/v1/schedule?sportId=1&gameType=W&season=${yr}&hydrate=team`);
          const games = []; (sch.dates || []).forEach(d => (d.games || []).forEach(g => games.push(g)));
          if (!games.length) return { none: true };
          games.sort((a, b) => Date.parse(a.gameDate) - Date.parse(b.gameDate));
          /* MLB posts the dates months early with no teams: only show from 2 days before Game 1, once both teams are known */
          const g1 = games[0], known = t => t && t.team && t.team.id && t.team.abbreviation && !/tbd/i.test(t.team.name || '');
          if (Date.parse(g1.gameDate) - Date.now() > 2 * 864e5 || !known(g1.teams.away) || !known(g1.teams.home)) return { none: true };
          const teams = {};
          [games[0].teams.away.team, games[0].teams.home.team].forEach(t => { teams[t.id] = { id: t.id, abbr: t.abbreviation || '', name: t.teamName || t.name || '', logo: `https://www.mlbstatic.com/team-logos/${t.id}.svg`, wins: 0 }; });
          const list = games.filter(g => !/postponed|cancel|suspended/i.test((g.status || {}).detailedState || '')).map(g => {
            const s = g.status || {}, fin = s.abstractGameState === 'Final', a = g.teams.away, h = g.teams.home;
            if (fin && teams[a.team.id] && teams[h.team.id]) { if (a.isWinner) teams[a.team.id].wins++; else if (h.isWinner) teams[h.team.id].wins++; }
            return { n: g.seriesGameNumber || 0, pk: g.gamePk, date: g.gameDate, state: s.abstractGameState === 'Live' ? 'live' : fin ? 'final' : 'pre', detail: s.detailedState || '',
              away: { id: a.team.id, abbr: a.team.abbreviation || '', score: a.score }, home: { id: h.team.id, abbr: h.team.abbreviation || '', score: h.score },
              winner: fin ? (a.isWinner ? a.team.id : h.isWinner ? h.team.id : null) : null, ifNec: g.ifNecessary === 'Y', venue: (g.venue || {}).name || '' };
          });
          const T = Object.values(teams), champ = T.find(t => t.wins >= 4) || null;
          const lastFinal = list.filter(g => g.state === 'final').pop();
          const cur = list.find(g => g.state === 'live') || (!champ ? list.find(g => g.state === 'pre') : null) || lastFinal || null;
          const showFeed = cur && (cur.state === 'live' || (cur.state === 'final' && Date.now() - Date.parse(cur.date) < 20 * 3600e3) || (cur.state === 'pre' && Date.parse(cur.date) - Date.now() < 3 * 3600e3));
          const game = showFeed ? await mlbFeed(cur.pk).catch(() => null) : null;
          return { season: yr, teams: T, champ: champ ? champ.id : null, games: list.filter(g => !(champ && g.state === 'pre')), cur, game, ended: champ && lastFinal ? lastFinal.date : null };
        });
        return json(data);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---------- Live traffic map tiles (TomTom): /tt/Z/X/Y.png?key=... ---------- */
    if (path.startsWith('/tt/')) {
      if (!keyOk()) return new Response('Forbidden', { status: 403, headers: cors });
      if (!env.TOMTOM_KEY) return new Response('TomTom key not set up', { status: 500, headers: cors });
      const m = path.match(/^\/tt\/(\d{1,2})\/(\d+)\/(\d+)\.png$/);
      if (!m) return new Response('Bad tile', { status: 400, headers: cors });
      const [, z, x, y] = m.map(Number);
      if (z < 3 || z > 18 || x >= 2 ** z || y >= 2 ** z) return new Response('Bad tile', { status: 400, headers: cors });
      /* the same tile is reused for 10 minutes, whoever asks, so the free monthly allowance goes a long way */
      const slot = Math.floor(Date.now() / 600000);
      const ck = new Request(`https://nova-cache.local/tt/${z}/${x}/${y}/${slot}`);
      let hit = await caches.default.match(ck);
      if (!hit) {
        const tk = encodeURIComponent(String(env.TOMTOM_KEY).trim());
        let r = await fetch(`https://api.tomtom.com/traffic/map/4/tile/flow/relative0-dark/${z}/${x}/${y}.png?key=${tk}&tileSize=512`);
        if (!r.ok && r.status === 400) r = await fetch(`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${tk}`);
        if (!r.ok) { const why = (await r.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
          return new Response(`Traffic tile unavailable. TomTom answered ${r.status}: ${why || r.statusText}`, { status: r.status, headers: cors }); }
        const buf = await r.arrayBuffer();
        hit = new Response(buf, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600' } });
        await caches.default.put(ck, hit.clone());
      }
      const h = new Headers(cors); h.set('Content-Type', 'image/png'); h.set('Cache-Control', 'public, max-age=600');
      return new Response(hit.body, { status: 200, headers: h });
    }

    /* ---------- Live game: /live?league=nhl&team=TOR | league=mlb&team=141 | league=ohl&id=GAMEID&code=ohl&ht=KEY ---------- */
    if (path === '/live') {
      const league = (reqUrl.searchParams.get('league') || '').toLowerCase();
      const pad2 = n => String(n).padStart(2, '0');
      try {
        /* ===== NHL ===== */
        if (league === 'nhl') {
          const team = (reqUrl.searchParams.get('team') || 'TOR').toUpperCase();
          if (!/^[A-Z]{3}$/.test(team)) return json({ error: 'Bad team' }, 400);
          const data = await cached('live-nhl-' + team + '-v2', 8, async () => {
            const NHL = 'https://api-web.nhle.com/v1';
            const sc = await getJSON(`${NHL}/score/now`);
            const g0 = (sc.games || []).find(g => g.homeTeam.abbrev === team || g.awayTeam.abbrev === team);
            if (!g0) return { none: true };
            const [pbp, box] = await Promise.all([getJSON(`${NHL}/gamecenter/${g0.id}/play-by-play`), getJSON(`${NHL}/gamecenter/${g0.id}/boxscore`).catch(() => ({}))]);
            const H = pbp.homeTeam || {}, A = pbp.awayTeam || {};
            const who = {}; (pbp.rosterSpots || []).forEach(r => { who[r.playerId] = { n: (r.lastName && r.lastName.default) || '', f: (r.firstName && r.firstName.default) || '', team: r.teamId, img: r.headshot || '' }; });
            let lastGoal = null;
            const nm = id => (who[id] && who[id].n) || '';
            const side = id => id === H.id ? 'h' : id === A.id ? 'a' : '';
            const ab = s => s === 'h' ? H.abbrev : A.abbrev;
            const perName = pd => !pd ? '' : pd.periodType === 'SO' ? 'SO' : pd.periodType === 'OT' ? (pd.number > 4 ? (pd.number - 3) + 'OT' : 'OT') : ['1st', '2nd', '3rd'][pd.number - 1] || pd.number + 'th';
            const plays = pbp.plays || [];
            const shots = [], periods = {}, feed = [];
            for (const p of plays) {
              const d = p.details || {}, t = p.typeDescKey || '', s = side(d.eventOwnerTeamId), pn = perName(p.periodDescriptor);
              if (pn && !periods[pn]) periods[pn] = { p: pn, a: 0, h: 0, as: 0, hs: 0 };
              const kind = t === 'goal' ? 'goal' : t === 'shot-on-goal' ? 'sog' : t === 'missed-shot' ? 'miss' : t === 'blocked-shot' ? 'block' : '';
              if (kind && s && d.xCoord != null && d.yCoord != null) {
                /* blocked shots are owned by the blocking team: flip to the shooter */
                const sh = kind === 'block' ? (s === 'h' ? 'a' : 'h') : s;
                let x = d.xCoord, y = d.yCoord;
                if ((sh === 'h' && x < 0) || (sh === 'a' && x > 0)) { x = -x; y = -y; }
                shots.push({ t: kind, s: sh, x, y });
              }
              if (pn && s && (kind === 'goal' || kind === 'sog')) { periods[pn][s + 's']++; if (kind === 'goal') periods[pn][s]++; }
              const when = pn + ' ' + (p.timeInPeriod || '');
              if (t === 'goal') {
                const as = [d.assist1PlayerId, d.assist2PlayerId].filter(Boolean).map(nm).filter(Boolean);
                const sc = who[d.scoringPlayerId] || {};
                lastGoal = { s, team: ab(s), name: [sc.f, sc.n].filter(Boolean).join(' '), n: d.scoringPlayerTotal || null, assists: as, img: sc.img || '', when, id: p.eventId };
                feed.push({ when, goal: true, s, text: `GOAL ${ab(s)} · ${nm(d.scoringPlayerId)}${d.scoringPlayerTotal ? ' (' + d.scoringPlayerTotal + ')' : ''}${as.length ? ', assists ' + as.join(', ') : ', unassisted'}` });
              } else if (t === 'shot-on-goal') feed.push({ when, s, text: `Shot · ${nm(d.shootingPlayerId)}${d.shotType ? ' ' + d.shotType : ''}${d.goalieInNetId ? ', saved by ' + nm(d.goalieInNetId) : ''}` });
              else if (t === 'penalty') feed.push({ when, s, pen: true, text: `Penalty · ${ab(s)} ${nm(d.committedByPlayerId) || 'bench'}, ${d.duration || 2} min ${String(d.descKey || '').replace(/-/g, ' ')}` });
              else if (t === 'hit') feed.push({ when, s, text: `Hit · ${nm(d.hittingPlayerId)} on ${nm(d.hitteePlayerId)}` });
              else if (t === 'period-end') feed.push({ when, text: `End of ${pn}` });
            }
            /* power play from the situation code (away goalie, away skaters, home skaters, home goalie) */
            let pp = null; const sit = String(pbp.situationCode || (plays.length && plays[plays.length - 1].situationCode) || '');
            if (/^\d{4}$/.test(sit)) { const as = +sit[1], hs = +sit[2]; if (as !== hs) pp = { s: as > hs ? 'a' : 'h', label: `${as > hs ? A.abbrev : H.abbrev} ${Math.max(as, hs)} on ${Math.min(as, hs)}` }; }
            if (pbp.situation && pbp.situation.timeRemaining && pp) pp.time = pbp.situation.timeRemaining;
            const pbg = box.playerByGameStats || {};
            const skaters = tm => [...((tm || {}).forwards || []), ...((tm || {}).defense || [])];
            const top = tm => skaters(tm).map(p => ({ name: (p.name && p.name.default) || '', g: p.goals || 0, a: p.assists || 0, sog: p.sog != null ? p.sog : (p.shots || 0), hits: p.hits || 0, toi: p.toi || '' }))
              .sort((x, y) => (y.g + y.a) - (x.g + x.a) || y.g - x.g || y.sog - x.sog || y.hits - x.hits).slice(0, 3);
            const goalie = tm => { const gs = ((tm || {}).goalies || []).filter(g => g.toi && g.toi !== '00:00'); const g = gs.sort((a, b) => (b.toi > a.toi ? 1 : -1))[0]; if (!g) return null;
              const sa = String(g.saveShotsAgainst || ''), m = sa.match(/(\d+)\/(\d+)/);
              return { name: (g.name && g.name.default) || '', saves: m ? +m[1] : (g.saves || 0), shots: m ? +m[2] : (g.shotsAgainst || 0), sv: g.savePctg != null ? Number(g.savePctg).toFixed(3).replace(/^0/, '') : '' }; };
            const clock = pbp.clock || {}, pd = pbp.periodDescriptor || {};
            const st = /^(LIVE|CRIT)$/.test(pbp.gameState) ? (clock.inIntermission ? 'int' : 'live') : /^(OFF|FINAL)$/.test(pbp.gameState) ? 'final' : 'pre';
            const tmInfo = (T, s) => ({ s, abbr: T.abbrev, name: (T.commonName && T.commonName.default) || (T.name && T.name.default) || T.abbrev, logo: T.darkLogo || T.logo || '', score: T.score || 0, sog: T.sog || 0 });
            return { sport: 'hockey', league: 'NHL', id: g0.id, state: st, per: perName(pd), clock: clock.timeRemaining || '', running: !!clock.running, start: pbp.startTimeUTC,
              away: tmInfo(A, 'a'), home: tmInfo(H, 'h'), pp, shots, lastGoal, periods: Object.values(periods), feed: feed.slice(-8).reverse(),
              top: { a: top(pbg.awayTeam), h: top(pbg.homeTeam) }, goalies: { a: goalie(pbg.awayTeam), h: goalie(pbg.homeTeam) } };
          });
          return json(data);
        }

        /* ===== MLB ===== */
        if (league === 'mlb') {
          const teamId = parseInt(reqUrl.searchParams.get('team') || '141', 10);
          if (!(teamId > 0)) return json({ error: 'Bad team' }, 400);
          const data = await cached('live-mlb-' + teamId + '-v5', 8, async () => {
            const MLB = 'https://statsapi.mlb.com/api';
            const d = new Date(Date.now() - 5 * 3600e3), day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
            const sch = await getJSON(`${MLB}/v1/schedule?sportId=1&teamId=${teamId}&date=${day}&gameType=S,E,R,F,D,L,W`);
            const games = ((sch.dates || [])[0] || {}).games || [];
            const g0 = games.find(g => g.status && g.status.abstractGameState === 'Live') || games[0];
            if (!g0) return { none: true };
            return await mlbFeed(g0.gamePk);
          });
          return json(data);
        }

        /* ===== OHL (HockeyTech) ===== */
        if (league === 'ohl') {
          const id = reqUrl.searchParams.get('id') || '', code = (reqUrl.searchParams.get('code') || 'ohl').replace(/[^a-z]/gi, ''), ht = (reqUrl.searchParams.get('ht') || '').replace(/[^a-z0-9]/gi, '');
          if (!/^\d+$/.test(id) || !ht) return json({ error: 'Bad game' }, 400);
          const data = await cached(`live-ohl-${id}-v2`, 10, async () => {
            const B = 'https://lscluster.hockeytech.com/feed/index.php';
            const parse = async u => { let t = (await (await fetch(u, { headers: { 'User-Agent': 'NovaDashboard/1.0' } })).text()).trim();
              if (!/^[\[{]/.test(t)) { const a = t.indexOf('('), b = t.lastIndexOf(')'); if (a >= 0 && b > a) t = t.slice(a + 1, b); } return JSON.parse(t); };
            const [sum, gc] = await Promise.all([
              parse(`${B}?feed=statviewfeed&view=gameSummary&game_id=${id}&key=${ht}&site_id=2&client_code=${code}&lang=en&league_id=`),
              parse(`${B}?feed=gc&key=${ht}&client_code=${code}&game_id=${id}&lang_code=en&fmt=json&tab=pxpverbose`).catch(() => ({})),
            ]);
            const HT = sum.homeTeam || {}, VT = sum.visitingTeam || {};
            const info = (T, s) => { const i = T.info || {}, st = T.stats || {};
              return { s, id: String(i.id || ''), abbr: i.abbreviation || '', name: i.nickname || i.name || '', logo: i.logo || '', score: +(st.goals != null ? st.goals : st.goalCount) || 0, sog: +st.shots || 0 }; };
            const home = info(HT, 'h'), away = info(VT, 'a');
            const pName = p => (p && (p.lastName || p.last_name)) || '';
            const periods = (sum.periods || []).map(p => ({ p: (p.info && (p.info.shortName || p.info.longName)) || '', a: +((p.stats || {}).visitingGoals) || 0, h: +((p.stats || {}).homeGoals) || 0,
              as: +((p.stats || {}).visitingShots) || 0, hs: +((p.stats || {}).homeShots) || 0 }));
            const feed = [];
            (sum.periods || []).forEach(p => { const pn = (p.info && (p.info.shortName || p.info.longName)) || '';
              (p.goals || []).forEach(g => { const s = String((g.team || {}).id || '') === home.id ? 'h' : 'a';
                feed.push({ when: pn + ' ' + (g.time || ''), goal: true, s, text: `GOAL ${(g.team || {}).abbreviation || ''} · ${pName(g.scoredBy)}${g.scorerGoalNumber ? ' (' + g.scorerGoalNumber + ')' : ''}${(g.assists || []).length ? ', assists ' + g.assists.map(pName).join(', ') : ''}`, k: (p.info && p.info.id || 0) * 1e4 + toSec(g.time) }); });
              (p.penalties || []).forEach(x => { const s = String((x.againstTeam || x.team || {}).id || '') === home.id ? 'h' : 'a';
                feed.push({ when: pn + ' ' + (x.time || ''), s, pen: true, text: `Penalty · ${((x.againstTeam || x.team || {}).abbreviation) || ''} ${pName(x.takenBy)}, ${x.minutes || 2} min ${String(x.description || '').toLowerCase()}`, k: (p.info && p.info.id || 0) * 1e4 + toSec(x.time) }); }); });
            function toSec(t) { const m = String(t || '').match(/(\d+):(\d+)/); return m ? (+m[1]) * 60 + (+m[2]) : 0; }
            feed.sort((a, b) => b.k - a.k);
            const shots = [];
            (((gc || {}).GC || {}).Pxpverbose || []).forEach(e => {
              if (!/^(shot|goal)$/.test(e.event || '')) return;
              let x = parseFloat(e.x_location), y = parseFloat(e.y_location); if (!isFinite(x) || !isFinite(y)) return;
              const s = e.home === '1' || e.home === 1 || String(e.team_id || '') === home.id ? 'h' : 'a';
              x = x / 600 * 200 - 100; y = y / 300 * 85 - 42.5;
              if ((s === 'h' && x < 0) || (s === 'a' && x > 0)) { x = -x; y = -y; }
              shots.push({ t: e.event === 'goal' || e.goal === '1' ? 'goal' : 'sog', s, x, y });
            });
            const top = T => (T.skaters || []).map(p => { const i = p.info || {}, st = p.stats || {}; return { name: i.lastName || '', g: +st.goals || 0, a: +st.assists || 0, sog: +st.shots || 0, hits: +st.hits || 0 }; })
              .sort((x, y) => (y.g + y.a) - (x.g + x.a) || y.g - x.g || y.sog - x.sog).slice(0, 3);
            const goalie = T => { const g = (T.goalies || []).map(p => ({ i: p.info || {}, st: p.stats || {} })).sort((a, b) => (+b.st.shotsAgainst || 0) - (+a.st.shotsAgainst || 0))[0]; if (!g) return null;
              const sa = +g.st.shotsAgainst || 0, sv = g.st.saves != null ? +g.st.saves : sa - (+g.st.goalsAgainst || 0);
              return { name: g.i.lastName || '', saves: sv, shots: sa, sv: sa ? (sv / sa).toFixed(3).replace(/^0/, '') : '' }; };
            const det = sum.details || {};
            const allGoals = feed.filter(f => f.goal).slice().reverse().map(({ k, ...r }) => r);
            return { sport: 'hockey', league: 'OHL', id, goals: allGoals, state: det.final === '1' || /final/i.test(det.status || '') ? 'final' : 'live', away, home, pp: null, shots, periods,
              feed: feed.slice(0, 8).map(({ k, ...r }) => r), top: { a: top(VT), h: top(HT) }, goalies: { a: goalie(VT), h: goalie(HT) } };
          });
          return json(data);
        }
        return json({ error: 'Unknown league' }, 400);
      } catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    /* ---- feed relay: /?url=... ---- */
    const target = reqUrl.searchParams.get('url');
    if (!target) return new Response('Nova relay is running (v27).', { headers: cors });

    let u;
    try { u = new URL(target); } catch { return new Response('Bad url', { status: 400, headers: cors }); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return new Response('Bad url', { status: 400, headers: cors });
    if (/outlook\.(live|office|office365)\.com$/i.test(u.hostname) && /\/calendar/i.test(u.pathname))
      return new Response('Use /calendar', { status: 403, headers: cors });
    if (env.JF_URL && u.hostname === new URL(env.JF_URL).hostname)
      return new Response('Use /jellyfin', { status: 403, headers: cors });

    const upstream = await fetch(u.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 NovaDashboard' },
      cf: { cacheTtl: 300, cacheEverything: true },
      redirect: 'follow',
    });
    const type = upstream.headers.get('Content-Type') || '';
    if (type && !OK_TYPES.test(type)) return new Response('Only feeds and calendars are relayed', { status: 415, headers: cors });

    const headers = new Headers(cors);
    headers.set('Content-Type', type || 'text/plain; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=300');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
