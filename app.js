/* SD Trip app. No personal data lives in this file: the trip loads from the private Google script with the trip code. */
(function () {
  'use strict';

  // ---------- storage + config ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage off */ } },
  };
  const API = LS.get('sdtrip_api', null) || (window.SDTRIP_CONFIG && window.SDTRIP_CONFIG.apiUrl) || '';
  const TZN = { ET: 'America/New_York', PT: 'America/Los_Angeles' };
  const win = () => (S.trip && S.trip.window) || { sdStart: '1970-01-01T00:00:00Z', sdEnd: '1970-01-01T00:00:00Z', firstDay: '1970-01-01', days: 1 };
  const SD_START_ = () => Date.parse(win().sdStart);
  const SD_END_ = () => Date.parse(win().sdEnd);

  const S = {
    key: LS.get('sdtrip_key', null),
    who: LS.get('sdtrip_who', null),
    trip: null,
    expenses: [],
    queue: LS.get('sdtrip_queue', []),
    tab: 'now',
    budgetFilter: 'Us',
    dayFilter: 'all',
    map: null, markers: {}, route: null, me: null, meMarker: null, meCircle: null, watchId: null, fitMe: true,
    syncing: false,
  };

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const money0 = (n) => '$' + Math.round(n).toLocaleString('en-US');

  // ---------- time ----------
  const fmtTime = (iso, tz) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZN[tz] }).format(new Date(iso));
  const dayKeyNow = () => {
    const t = Date.now();
    const tz = t >= SD_START_() - 6 * 3600e3 && t <= SD_END_() + 3 * 3600e3 ? 'PT' : 'ET';
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZN[tz] }).format(new Date());
  };
  const dayLabel = (key) => {
    const d = new Date(key + 'T12:00:00Z');
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
  };
  const rel = (ms) => {
    const m = Math.round(ms / 60000);
    if (m <= 0) return 'now';
    if (m < 60) return 'in ' + m + ' min';
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return 'in ' + h + ' h' + (mm ? ' ' + mm + ' min' : '');
    const d = Math.floor(h / 24), hh = h % 24;
    return 'in ' + d + (d === 1 ? ' day' : ' days') + (hh ? ' ' + hh + ' h' : '');
  };
  const events = () => (S.trip ? S.trip.events : []).map((e) => Object.assign({}, e, {
    ts: Date.parse(e.at), te: Date.parse(e.at) + (e.mins || 30) * 60000,
  })).sort((a, b) => a.ts - b.ts);

  // ---------- ui helpers ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function setSync(state, text) {
    const el = $('#sync');
    el.className = 'sync ' + state;
    $('#sync-text').textContent = text;
  }
  function place(id) { return id && S.trip && S.trip.places ? S.trip.places[id] : null; }
  function appleMaps(p) {
    return p.far && p.q ? 'https://maps.apple.com/?daddr=' + encodeURIComponent(p.q)
      : 'https://maps.apple.com/?daddr=' + p.lat + ',' + p.lng + '&q=' + encodeURIComponent(p.name);
  }
  function googleMaps(p) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + (p.far && p.q ? encodeURIComponent(p.q) : p.lat + ',' + p.lng);
  }
  const ICON_DIR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 20.5 4 13 21.5l-2.2-7.3z"/></svg>';

  // ---------- api ----------
  async function post(body) {
    const res = await fetch(API, { method: 'POST', body: JSON.stringify(Object.assign({ k: S.key }, body)), redirect: 'follow' });
    return res.json();
  }

  async function sync(quiet) {
    if (!S.key || !API || S.syncing) return;
    S.syncing = true;
    if (!quiet) setSync('busy', 'Syncing');
    try {
      await flushQueue();
      const j = await post({ op: 'all' });
      if (!j.ok) {
        if (j.error === 'bad_key') return forgetKey('That trip code did not work. Check the link you were sent.');
        throw new Error(j.error || 'failed');
      }
      applyData(j);
      LS.set('sdtrip_cache', { trip: j.trip, expenses: j.expenses, at: Date.now() });
      setSync('ok', 'Synced ' + fmtClock(Date.now()));
    } catch (e) {
      const c = LS.get('sdtrip_cache', null);
      setSync('off', c ? 'Offline · saved copy' : 'Offline');
    } finally {
      S.syncing = false;
    }
  }
  function fmtClock(t) { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(t)); }

  async function flushQueue() {
    while (S.queue.length) {
      const op = S.queue[0];
      const j = await post(op);
      if (!j.ok && j.error === 'bad_key') throw new Error('bad_key');
      S.queue.shift();
      LS.set('sdtrip_queue', S.queue);
      if (j.ok && j.expenses) S.expenses = j.expenses;
    }
  }

  function applyData(j) {
    const first = !S.trip;
    S.trip = j.trip;
    S.expenses = mergePending(j.expenses || []);
    renderAll();
    if (first) initFormOptions();
  }
  function mergePending(serverList) {
    const list = serverList.slice();
    S.queue.forEach((op) => {
      if (op.op === 'add' && !list.some((x) => x.id === op.item.id)) list.push(Object.assign({ pending: true }, op.item));
      if (op.op === 'delete') { const i = list.findIndex((x) => x.id === op.id); if (i > -1) list.splice(i, 1); }
    });
    return list;
  }

  // ---------- gate ----------
  function readHashKey() {
    const m = location.hash.match(/k=([A-Za-z0-9_-]{8,})/);
    if (m) { S.key = m[1]; LS.set('sdtrip_key', S.key); }
    keepKeyInUrl();
  }
  // A Home Screen app on iPhone gets its own storage and starts from the page address,
  // so the code stays in the address (the part after # never reaches any server).
  function keepKeyInUrl() {
    const want = S.key ? '#k=' + S.key : '';
    if (location.hash !== want) history.replaceState(null, '', location.pathname + location.search + want);
  }
  function forgetKey(msg) {
    S.key = null; LS.del('sdtrip_key'); LS.del('sdtrip_cache'); keepKeyInUrl();
    $('#gate-msg').textContent = msg || 'Open the link you were sent, or enter the trip code.';
    $('#gate').hidden = false;
  }
  function boot() {
    readHashKey();
    applyTheme(LS.get('sdtrip_theme', 'dark'));
    if (!S.key) { $('#gate').hidden = false; return; }
    const c = LS.get('sdtrip_cache', null);
    if (c) { applyData(c); setSync('ok', 'Saved copy'); }
    sync();
  }
  $('#gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#gate-code').value.trim().replace(/^.*k=/, '');
    if (v.length < 8) { $('#gate-msg').textContent = 'That code looks too short.'; return; }
    S.key = v; LS.set('sdtrip_key', v); keepKeyInUrl();
    $('#gate').hidden = true;
    sync();
  });
  $('#who-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-who]'); if (!b) return;
    S.who = b.dataset.who; LS.set('sdtrip_who', S.who);
    $('#who').hidden = true; renderAll();
    toast('Hi ' + S.who);
  });
  function people() { return (S.trip && S.trip.people) || []; }
  function renderWho() {
    $('#who-row').innerHTML = people().map((p) => '<button type="button" class="btn big" data-who="' + esc(p) + '">' + esc(p) + '</button>').join('');
  }

  // ---------- tabs ----------
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  function showTab(tab) {
    S.tab = tab;
    $$('.tabs [data-tab]').forEach((b) => b.toggleAttribute('aria-current', b.dataset.tab === tab));
    $$('.tabs [aria-current]').forEach((b) => b.setAttribute('aria-current', 'page'));
    $$('#main .view').forEach((v) => {
      const on = v.dataset.view === tab;
      v.hidden = !on;
      if (on) { v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter'); }
    });
    $('#add-fab') && ($('#add-fab').hidden = tab !== 'budget');
    if (tab === 'map') { initMap(); setTimeout(() => S.map && S.map.invalidateSize(), 60); }
    if (tab === 'budget') renderBudget();
  }

  // ---------- render: header ----------
  function renderHeader() {
    const t = Date.now();
    const evs = events();
    const today = dayKeyNow();
    const first = evs.find((e) => e.day === win().firstDay);
    if (first && t < first.ts - 12 * 3600e3) {
      $('#top-eyebrow').textContent = 'San Diego · trip starts';
      $('#top-day').textContent = rel(first.ts - t).replace('in ', 'In ');
    } else if (t > SD_END_() + 12 * 3600e3) {
      $('#top-eyebrow').textContent = 'San Diego · home again';
      $('#top-day').textContent = dayLabel(today);
    } else {
      const n = Math.min(win().days, Math.max(1, Math.floor((Date.parse(today + 'T12:00:00Z') - Date.parse(win().firstDay + 'T12:00:00Z')) / 864e5) + 1));
      $('#top-eyebrow').textContent = 'San Diego · day ' + n + ' of ' + win().days;
      $('#top-day').textContent = dayLabel(today);
    }
  }

  // ---------- render: now ----------
  function whoChip(w) {
    const i = people().indexOf(w);
    if (i < 0) return '';
    return '<span class="chip ' + (i === 0 ? 'teal' : 'coral') + '">' + esc(w) + '</span>';
  }
  function eventRow(e, i, extra) {
    const p = place(e.place);
    const t = Date.now();
    const cls = [e.te < t ? 'past' : '', extra && extra.nextId === e.id ? 'is-next' : ''].join(' ').trim();
    return '<li class="rise ' + cls + '" style="--i:' + i + '">' +
      '<div class="t">' + esc(fmtTime(e.at, e.tz)) + '<small>' + e.tz + '</small></div>' +
      '<div><h3>' + esc(e.title) + '</h3>' + (e.note ? '<p>' + esc(e.note) + '</p>' : '') +
      '<div class="meta">' + whoChip(e.who) +
      (p ? '<button class="linkish" data-goto="' + esc(e.place) + '">' + esc(p.name) + '</button>' : '') +
      '</div></div></li>';
  }
  function renderNow() {
    const v = $('#view-now');
    if (!S.trip) { v.innerHTML = '<p class="sub">Loading the trip…</p>'; return; }
    const t = Date.now();
    const evs = events();
    const current = evs.filter((e) => e.ts <= t && t < e.te && e.kind !== 'task').pop();
    const next = evs.find((e) => e.ts > t);
    let html = '';

    const hero = (e, isNow) => {
      const p = place(e.place);
      const ms = e.ts - t;
      const going = e.kind === 'go' || e.kind === 'car';
      const hot = going && ms < 15 * 60000 && ms > -5 * 60000;
      return '<article class="next rise">' +
        '<div class="next-top"><span class="pulse"></span><span class="label">' + (isNow ? 'Happening now' : 'Next up') + '</span>' + whoChip(e.who) + '</div>' +
        '<div class="when">' + esc(fmtTime(e.at, e.tz)) + '<small>' + e.tz + ' · ' + esc(dayLabel(e.day)) + '</small></div>' +
        '<h2>' + esc(e.title) + '</h2>' +
        (e.note ? '<p class="sub" style="margin:0">' + esc(e.note) + '</p>' : '') +
        (!isNow && going ? '<div class="leave' + (hot ? ' hot' : '') + '"><b>Leave ' + (ms <= 0 ? 'now' : 'at ' + esc(fmtTime(e.at, e.tz))) + '</b><span class="count">' + esc(rel(ms)) + '</span></div>'
          : (!isNow ? '<span class="count">Starts ' + esc(rel(ms)) + '</span>' : '')) +
        (p ? '<div class="row"><a class="btn primary sm" href="' + appleMaps(p) + '" target="_blank" rel="noopener">' + ICON_DIR + 'Directions</a>' +
          (p.far ? '' : '<button class="btn sm" data-goto="' + esc(e.place) + '">On the map</button>') + '</div>' : '') +
        '</article>';
    };

    if (current) html += hero(current, true);
    if (next) html += hero(next, false);
    if (!current && !next) {
      html += '<article class="next rise"><div class="next-top"><span class="label">Home again</span></div><h2>File the Atrium expense report this week.</h2><button class="btn sm" data-tabgo="budget">See the Atrium list</button></article>';
    }

    const today = dayKeyNow();
    let dayEvents = evs.filter((e) => e.day === today);
    let heading = 'Today';
    if (!dayEvents.length && next) { dayEvents = evs.filter((e) => e.day === next.day); heading = dayLabel(next.day); }
    if (dayEvents.length) {
      html += '<div class="day-h"><h2>' + esc(heading) + '</h2><span>' + dayEvents.length + (dayEvents.length === 1 ? ' item' : ' items') + '</span></div>';
      html += '<ol class="tl">' + dayEvents.map((e, i) => eventRow(e, i, { nextId: next && next.id })).join('') + '</ol>';
    }
    v.innerHTML = '<div class="stack">' + html + '</div>';
  }

  // ---------- render: plan ----------
  function renderPlan() {
    const v = $('#view-plan');
    if (!S.trip) return;
    const t = Date.now();
    const evs = events();
    const next = evs.find((e) => e.ts > t);
    const days = [...new Set(evs.map((e) => e.day))];
    const sleep = S.trip.sleep || {};
    v.innerHTML = days.map((d) => {
      const list = evs.filter((e) => e.day === d);
      return '<div class="day-h" id="day-' + d + '"><h2>' + esc(dayLabel(d)) + '</h2><span>' + (sleep[d] ? 'Sleep: ' + esc(sleep[d]) : '') + '</span></div>' +
        '<ol class="tl">' + list.map((e, i) => eventRow(e, i, { nextId: next && next.id })).join('') + '</ol>';
    }).join('');
  }

  // ---------- map ----------
  function initMap() {
    if (S.map || !window.L || !S.trip) return;
    const m = L.map('map', { zoomControl: false, attributionControl: true, tap: true }).setView([32.74, -117.19], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    S.map = m;
    Object.entries(S.trip.places).forEach(([id, p]) => {
      if (p.far) return;
      const mk = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: 'pin ' + p.type, html: '<span></span>', iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] }),
        title: p.name, keyboard: true,
      }).addTo(m);
      mk.bindPopup(() => popupHtml(id));
      S.markers[id] = mk;
    });
    renderMapChips();
    applyDayFilter();
    m.on('dragstart', () => { S.fitMe = false; });
  }
  function popupHtml(id) {
    const p = place(id);
    const uses = events().filter((e) => e.place === id).map((e) => esc(dayLabel(e.day).split(',')[0]) + ' ' + esc(fmtTime(e.at, e.tz)) + ' · ' + esc(e.title));
    return '<div class="pop"><h3>' + esc(p.name) + '</h3><p>' + esc(p.area || '') + (uses.length ? '<br>' + uses.join('<br>') : '') + '</p>' +
      '<div class="row"><a class="btn primary sm" href="' + appleMaps(p) + '" target="_blank" rel="noopener">' + ICON_DIR + 'Apple Maps</a>' +
      '<a class="btn sm" href="' + googleMaps(p) + '" target="_blank" rel="noopener">Google</a></div></div>';
  }
  function tripDays() { return [...new Set(events().filter((e) => place(e.place) && !place(e.place).far).map((e) => e.day))]; }
  function renderMapChips() {
    const wrap = $('#map-chips');
    const days = tripDays();
    wrap.innerHTML = '<button data-day="all">All</button>' + days.map((d) => '<button data-day="' + d + '">' + esc(dayLabel(d).split(',')[0]) + '</button>').join('');
    $$('button', wrap).forEach((b) => b.addEventListener('click', () => { S.dayFilter = b.dataset.day; applyDayFilter(true); }));
  }
  function applyDayFilter(fit) {
    if (!S.map) return;
    $$('#map-chips button').forEach((b) => b.classList.toggle('on', b.dataset.day === S.dayFilter));
    const evs = events();
    const next = evs.find((e) => e.ts > Date.now() && place(e.place) && !place(e.place).far);
    const ids = S.dayFilter === 'all' ? null : evs.filter((e) => e.day === S.dayFilter && place(e.place) && !place(e.place).far).map((e) => e.place);
    Object.entries(S.markers).forEach(([id, mk]) => {
      const el = mk.getElement();
      if (!el) return;
      el.classList.toggle('dim', !!ids && !ids.includes(id));
      el.classList.toggle('next', !!next && next.place === id);
    });
    if (S.route) { S.route.remove(); S.route = null; }
    let bounds;
    if (ids && ids.length) {
      const pts = ids.filter((id, i) => ids[i - 1] !== id).map((id) => [place(id).lat, place(id).lng]);
      if (pts.length > 1) S.route = L.polyline(pts, { color: getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#F2B544', weight: 3, dashArray: '6 8', opacity: .9 }).addTo(S.map);
      bounds = L.latLngBounds(pts);
    } else {
      bounds = L.latLngBounds(Object.values(S.trip.places).filter((p) => !p.far && p.lat < 33).map((p) => [p.lat, p.lng]));
    }
    if (fit !== false && bounds) S.map.fitBounds(bounds.pad(0.18), { maxZoom: 15, animate: true });
    renderMapCard();
  }
  function renderMapCard() {
    const card = $('#map-card');
    const next = events().find((e) => e.ts > Date.now() && place(e.place) && !place(e.place).far);
    if (!next) { card.hidden = true; return; }
    const p = place(next.place);
    let dist = '';
    if (S.me) {
      const mi = haversine(S.me.lat, S.me.lng, p.lat, p.lng) / 1.609;
      dist = ' · ' + (mi < 0.1 ? 'you are here' : mi.toFixed(mi < 10 ? 1 : 0) + ' mi away');
    }
    card.innerHTML = '<span class="label">Next stop · ' + esc(dayLabel(next.day).split(',')[0]) + ' ' + esc(fmtTime(next.at, next.tz)) + '</span>' +
      '<h3>' + esc(next.title) + '</h3><p>' + esc(p.name) + esc(dist) + '</p>' +
      '<div class="row"><a class="btn primary sm" href="' + appleMaps(p) + '" target="_blank" rel="noopener">' + ICON_DIR + 'Directions</a>' +
      '<button class="btn sm" data-goto="' + esc(next.place) + '">Show</button></div>';
    card.hidden = false;
  }
  function haversine(a, b, c, d) {
    const r = Math.PI / 180, R = 6371;
    const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  $('#locate').addEventListener('click', () => {
    if (!('geolocation' in navigator)) { toast('This phone does not share location with web apps.'); return; }
    if (S.watchId != null) { if (S.me) { S.map.setView([S.me.lat, S.me.lng], 15); } return; }
    S.fitMe = true;
    $('#locate').classList.add('on');
    S.watchId = navigator.geolocation.watchPosition((pos) => {
      S.me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      const ll = [S.me.lat, S.me.lng];
      if (!S.meMarker) {
        S.meMarker = L.marker(ll, { icon: L.divIcon({ className: 'me-dot', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 1000, interactive: false }).addTo(S.map);
        S.meCircle = L.circle(ll, { radius: S.me.acc, color: '#4DA3FF', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(S.map);
      } else {
        S.meMarker.setLatLng(ll); S.meCircle.setLatLng(ll).setRadius(S.me.acc);
      }
      if (S.fitMe) { S.map.setView(ll, 15, { animate: true }); S.fitMe = false; }
      renderMapCard();
    }, (err) => {
      S.watchId = null; $('#locate').classList.remove('on');
      toast(err.code === 1 ? 'Location is off for this app. Turn it on in Settings, Privacy, Location Services, Safari Websites.' : 'Could not find your location yet. Try again outside.');
    }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
  });
  function gotoPlace(id) {
    showTab('map');
    setTimeout(() => {
      const mk = S.markers[id];
      if (!mk) return;
      S.fitMe = false;
      S.map.setView(mk.getLatLng(), 15, { animate: true });
      mk.openPopup();
    }, 120);
  }

  // ---------- budget ----------
  function cats() { return S.trip ? S.trip.budget.plan : []; }
  function catLabel(id) { const c = cats().find((x) => x.id === id); return c ? c.label : id; }
  function renderBudget() {
    const v = $('#view-budget');
    if (!S.trip) return;
    const us = S.expenses.filter((x) => x.payer !== 'Atrium');
    const at = S.expenses.filter((x) => x.payer === 'Atrium');
    const sum = (l) => l.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const plan = cats().reduce((a, c) => a + c.plan, 0);
    const usTotal = sum(us);
    const due = sum(us.filter((x) => x.status === 'due'));
    const atTotal = sum(at);
    const pct = Math.min(100, plan ? (usTotal / plan) * 100 : 0);
    const left = plan - usTotal;

    let html = '<article class="card sum rise">' +
      '<span class="label">Our spending</span>' +
      '<div class="sum-top"><div class="big-num">' + money0(usTotal) + '<small>of ' + money0(plan) + '</small></div>' +
      '<span class="chip ' + (left >= 0 ? 'green' : 'coral') + '">' + (left >= 0 ? money0(left) + ' left' : money0(-left) + ' over') + '</span></div>' +
      '<div class="bar' + (left < 0 ? ' over' : '') + '"><i data-w="' + pct.toFixed(1) + '"></i></div>' +
      (due ? '<p class="sub" style="margin:0">' + money(due) + ' of that is ' + esc((S.trip.info && S.trip.info.dueNote) || 'paid later') + '.</p>' : '') +
      '</article>';

    html += '<article class="card rise" style="--i:1">' + cats().filter((c) => c.plan > 0 || us.some((x) => x.category === c.id)).map((c) => {
      const s = sum(us.filter((x) => x.category === c.id));
      const p = c.plan ? Math.min(100, (s / c.plan) * 100) : (s ? 100 : 0);
      const over = c.plan && s > c.plan + 0.5;
      return '<div class="cat"><div class="cat-top"><span>' + esc(c.label) + '</span><span>' + money(s) + ' / ' + money0(c.plan) + '</span></div>' +
        '<div class="bar' + (over ? ' over' : '') + '"><i data-w="' + p.toFixed(1) + '"></i></div>' +
        (c.hint ? '<span class="sub" style="font-size:13px">' + esc(c.hint) + '</span>' : '') + '</div>';
    }).join('') + '</article>';

    html += '<article class="card rise" style="--i:2"><div class="sum-top"><div><span class="label">Atrium pays back</span><div class="big-num" style="font-size:36px;color:var(--teal)">' + money0(atTotal) + '</div></div>' +
      '<button class="btn sm" id="copy-report" type="button">Copy expense list</button></div>' +
      '<p class="sub" style="margin:8px 0 0">Log anything Atrium owes you here (work meals, the airport Uber). It becomes the expense report list.</p></article>';

    html += '<div class="seg rise" style="--i:3" id="bfilter">' + ['Us', 'Atrium', 'All'].map((f) => '<button type="button" data-f="' + f + '" class="' + (S.budgetFilter === f ? 'on' : '') + '">' + (f === 'Us' ? 'Ours' : f) + '</button>').join('') + '</div>';

    const list = S.expenses.filter((x) => S.budgetFilter === 'All' || (S.budgetFilter === 'Atrium' ? x.payer === 'Atrium' : x.payer !== 'Atrium'))
      .slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.at || '').localeCompare(String(a.at || '')));
    let lastDate = '';
    html += '<div>' + (list.length ? '' : '<p class="sub">Nothing logged here yet.</p>');
    let open = false;
    list.forEach((x) => {
      if (x.date !== lastDate) {
        if (open) html += '</ul>';
        html += '<p class="date-h">' + esc(x.date ? dayLabel(x.date) : 'No date') + '</p><ul class="exp">';
        open = true; lastDate = x.date;
      }
      html += '<li class="' + (x.pending ? 'pending' : '') + '"><span class="what">' + esc(x.what || catLabel(x.category)) + '</span><span class="amt">' + money(Number(x.amount) || 0) + '</span>' +
        '<div class="meta"><span class="chip ' + (x.payer === 'Atrium' ? 'teal' : 'muted') + '">' + (x.payer === 'Atrium' ? 'Atrium' : 'Ours') + '</span>' +
        '<span>' + esc(catLabel(x.category)) + '</span>' + (x.card ? '<span>· ' + esc(x.card) + '</span>' : '') +
        (x.status === 'due' ? '<span class="chip gold">Due later</span>' : '') +
        (x.by ? '<span>· ' + esc(x.by) + '</span>' : '') + (x.pending ? '<span>· waiting to sync</span>' : '') +
        '<button class="del" type="button" data-del="' + esc(x.id) + '">Delete</button></div></li>';
    });
    if (open) html += '</ul>';
    html += '</div>';

    v.innerHTML = '<div class="stack">' + html + '</div>' +
      '<button class="fab add" id="add-fab" type="button" aria-label="Add spending"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>';
    requestAnimationFrame(() => $$('.bar > i', v).forEach((i) => { i.style.width = i.dataset.w + '%'; }));
    $('#add-fab').hidden = S.tab !== 'budget';
  }

  // budget interactions (delegated)
  let armed = null, armTimer = null;
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-goto],[data-tabgo],[data-del],[data-f],#copy-report,#add-fab,[data-close],[data-copy],[data-theme-set],[data-who-set],#forget');
    if (!t) return;
    if (t.dataset.goto) return gotoPlace(t.dataset.goto);
    if (t.dataset.tabgo) return showTab(t.dataset.tabgo);
    if (t.dataset.f) { S.budgetFilter = t.dataset.f; return renderBudget(); }
    if (t.id === 'add-fab') return openSheet();
    if (t.hasAttribute('data-close')) return closeSheet();
    if (t.id === 'copy-report') return copyReport();
    if (t.dataset.copy) return copyText(t.dataset.copy, 'Copied');
    if (t.dataset.themeSet) { applyTheme(t.dataset.themeSet); LS.set('sdtrip_theme', t.dataset.themeSet); return renderInfo(); }
    if (t.dataset.whoSet) { S.who = t.dataset.whoSet; LS.set('sdtrip_who', S.who); toast('This phone is ' + S.who + '\'s'); return renderInfo(); }
    if (t.id === 'forget') { forgetKey('Trip code removed from this phone.'); return; }
    if (t.dataset.del) {
      const id = t.dataset.del;
      if (armed !== id) {
        armed = id; $$('.del.arm').forEach((b) => { b.classList.remove('arm'); b.textContent = 'Delete'; });
        t.classList.add('arm'); t.textContent = 'Tap again to delete';
        clearTimeout(armTimer); armTimer = setTimeout(() => { armed = null; t.classList.remove('arm'); t.textContent = 'Delete'; }, 3500);
        return;
      }
      armed = null;
      S.expenses = S.expenses.filter((x) => x.id !== id);
      S.queue.push({ op: 'delete', id }); LS.set('sdtrip_queue', S.queue);
      renderBudget(); toast('Deleted');
      sync(true);
    }
  });

  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); }
    catch (e) { toast('Copy did not work here. Long-press to copy instead.'); }
  }
  function copyReport() {
    const at = S.expenses.filter((x) => x.payer === 'Atrium').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const total = at.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const lines = at.map((x) => (x.date || '') + '  ' + (x.what || catLabel(x.category)) + '  ' + money(Number(x.amount) || 0) + (x.status === 'due' ? ' (estimate, confirm on receipt)' : ''));
    copyText(((S.trip.info && S.trip.info.reportTitle) || 'Trip expenses') + '\n' + lines.join('\n') + '\nTotal: ' + money(total), 'Expense list copied');
  }

  // ---------- add sheet ----------
  function initFormOptions() {
    $('#f-cat').innerHTML = cats().map((c, i) => '<button type="button" data-v="' + esc(c.id) + '" class="' + (c.id === 'food' ? 'on' : '') + '">' + esc(c.label) + '</button>').join('');
    $('#f-card').innerHTML = (S.trip.budget.cards || ['Capital One']).map((c) => '<option>' + esc(c) + '</option>').join('');
  }
  $('#f-cat').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#f-cat button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#f-payer').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#f-payer button').forEach((x) => x.classList.toggle('on', x === b));
  });
  function openSheet() {
    if (!S.trip) return;
    $('#add-form').reset();
    $('#f-err').hidden = true;
    $('#f-date').value = dayKeyNow();
    $$('#f-payer button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'Us'));
    $('#sheet').hidden = false;
    setTimeout(() => $('#f-amount').focus(), 280);
  }
  function closeSheet() { $('#sheet').hidden = true; }
  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#f-amount').value.replace(/[$,\s]/g, '');
    const amount = Math.round(parseFloat(raw) * 100) / 100;
    if (!(amount > 0) || amount > 20000) {
      $('#f-err').textContent = 'Enter the amount, like 18.50.'; $('#f-err').hidden = false; return;
    }
    const cat = ($('#f-cat .on') || {}).dataset ? $('#f-cat .on').dataset.v : 'other';
    const payer = $('#f-payer .on').dataset.v;
    const item = {
      id: 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: $('#f-date').value || dayKeyNow(),
      amount, what: $('#f-what').value.trim() || catLabel(cat), category: cat, payer,
      card: $('#f-card').value, by: S.who || '', status: 'paid',
    };
    S.expenses.push(Object.assign({ pending: true }, item));
    S.queue.push({ op: 'add', item }); LS.set('sdtrip_queue', S.queue);
    closeSheet();
    renderBudget();
    toast(money(amount) + ' added' + (payer === 'Atrium' ? ' to the Atrium list' : ''));
    sync(true);
  });

  // ---------- info ----------
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#EEF3F2' : '#0C171C');
  }
  function renderInfo() {
    const v = $('#view-info');
    if (!S.trip) return;
    const theme = document.documentElement.getAttribute('data-theme');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    const mine = calEvents();
    let html = '';
    html += '<article class="card rise"><span class="label">Alerts on your phone</span>' +
      '<h2 class="h2" style="font-size:24px">Add the trip to your calendar</h2>' +
      '<p class="sub">' + mine.length + ' stops for ' + esc(S.who || 'this phone') + ', with alarms before the ones where you need to leave. Your phone does the reminding, even when this app is closed. Tap the button, then <b>Add All</b>. Do it once on each phone.</p>' +
      '<div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="add-cal">Add alerts to my calendar</button></div></article>';
    if (!standalone) {
      html += '<article class="card rise" style="--i:1"><span class="label">Make it an app</span><p class="sub" style="margin:6px 0 0">In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>. It opens full screen like an app and remembers the trip code.</p></article>';
    }
    html += '<article class="card rise" style="--i:2"><span class="label">This phone</span>' +
      '<div class="seg" style="margin-top:8px">' + people().map((w) => '<button type="button" data-who-set="' + esc(w) + '" class="' + (S.who === w ? 'on' : '') + '">' + esc(w) + '</button>').join('') + '</div>' +
      '<div class="seg" style="margin-top:8px">' + [['dark', 'Dark'], ['light', 'Light']].map(([k, l]) => '<button type="button" data-theme-set="' + k + '" class="' + (theme === k ? 'on' : '') + '">' + l + '</button>').join('') + '</div></article>';
    html += '<article class="card rise" style="--i:3"><span class="label">Confirmations</span>' +
      (S.trip.info.confirmations || []).map((c) => '<div class="kv"><span>' + esc(c.label) + '</span><button class="btn sm" data-copy="' + esc(c.value) + '"><span class="v">' + esc(c.value) + '</span></button></div>').join('') + '</article>';
    html += '<article class="card rise" style="--i:4"><div class="stack">' + (S.trip.info.notes || []).map((n) => '<div class="note"><h3>' + esc(n.title) + '</h3><p>' + esc(n.body) + '</p></div>').join('') + '</div></article>';
    html += '<p class="sub" style="text-align:center">Spending saves to the Trip Budget tab in your Level 10 sheet.<br><button class="linkish" id="forget" type="button">Remove the trip code from this phone</button></p>';
    v.innerHTML = '<div class="stack">' + html + '</div>';
  }

  // ---------- calendar ----------
  // Built on the phone from the loaded trip, so no second trip to Google (which breaks when the
  // phone is signed in to Google). Each phone gets the shared stops plus its own.
  function calEvents() {
    return ((S.trip && S.trip.events) || []).filter((ev) => !ev.who || ev.who === 'Both' || !S.who || ev.who === S.who);
  }
  function buildIcs() {
    const e = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const fold = (l) => { let o = ''; while (l.length > 74) { o += l.slice(0, 74) + '\r\n '; l = l.slice(74); } return o + l; };
    const places = S.trip.places || {};
    const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SD Trip//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:' + e((S.trip.info && S.trip.info.calName) || 'SD Trip')];
    const stamp = utc(new Date());
    calEvents().forEach((ev) => {
      const start = new Date(ev.at);
      const end = new Date(start.getTime() + (ev.mins || 30) * 60000);
      const pl = ev.place ? places[ev.place] : null;
      out.push('BEGIN:VEVENT', 'UID:' + ev.id + '@sd-trip', 'DTSTAMP:' + stamp, 'DTSTART:' + utc(start), 'DTEND:' + utc(end), 'SUMMARY:' + e(ev.title));
      if (pl) out.push('LOCATION:' + e(pl.q || (pl.name + (pl.area ? ', ' + pl.area : ''))));
      if (ev.note) out.push('DESCRIPTION:' + e(ev.note));
      (ev.alerts || []).forEach((m) => out.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + e(ev.title), 'TRIGGER:-PT' + Number(m) + 'M', 'END:VALARM'));
      out.push('END:VEVENT');
    });
    out.push('END:VCALENDAR');
    return out.map(fold).join('\r\n') + '\r\n';
  }
  function addToCalendar() {
    if (!S.trip) return;
    const a = document.createElement('a');
    a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(buildIcs());
    a.download = 'sd-trip.ics';
    a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  document.addEventListener('click', (e) => { if (e.target.closest('#add-cal')) addToCalendar(); });

  // ---------- screen fit ----------
  // iPhone Home Screen apps report a viewport shorter than the screen by the status bar, so size to the screen.
  function fitScreen() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    const gap = screen.height - window.innerHeight;
    const st = document.documentElement.style;
    if (standalone && portrait && gap > 0 && gap < 120) { st.setProperty('--app-h', screen.height + 'px'); st.setProperty('--vp-gap', gap + 'px'); }
    else { st.removeProperty('--app-h'); st.removeProperty('--vp-gap'); }
  }
  fitScreen();
  window.addEventListener('resize', fitScreen);

  // ---------- all ----------
  function renderAll() {
    renderWho();
    if (S.key && !S.who && people().length) $('#who').hidden = false;
    renderHeader(); renderNow(); renderPlan(); renderBudget(); renderInfo();
    if (S.map) applyDayFilter(false);
  }
  setInterval(() => { if (S.trip) { renderHeader(); if (S.tab === 'now') renderNow(); if (S.map) applyDayFilter(false); } }, 30000);
  setInterval(() => { if (document.visibilityState === 'visible') sync(true); }, 120000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(true); });
  window.addEventListener('online', () => sync(true));

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
