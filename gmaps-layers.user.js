// ==UserScript==
// @name         Google Maps Layers: find X near each Y
// @namespace    https://github.com/JPInert/gmaps-layers
// @version      2.0
// @description  Several searches on the map at once (Superchargers + food) and what's within X mi of each, with filters for rating, reviews and open hours.
// @author       JPInert
// @match        https://www.google.com/maps*
// @grant        GM_xmlhttpRequest
// @inject-into  content
// @connect      www.google.com
// @noframes
// @license      MIT
// ==/UserScript==

// Map Layers v2 for Google Maps: "find X within N mi of each Y", drawn on the map
// as hubs (one per Y result) with a driving-friendly bottom sheet - swipe/click up
// for the full list.
// Read-only: calls the same /search?tbm=map endpoint
// Maps itself uses.
//
// Sections: CONST · PURE (node-testable) · STORE · API · ENGINE · MAP · UI · BOOT
(function () {
  'use strict';
  if (window.__gmLayers) window.__gmLayers.destroy();

  // ======================================================================= CONST
  // pb blob Maps sends with a search (captured 2026-10-04), cut to the groups that
  // carry what we read: !20m57 alone was 34% of every response; slim = 510 kB vs
  // 811 kB a page with name/coords/rating/reviews/category/photo/hours/price intact.
  const PB = '!4m8!1m3!1d82050.38743452655!2d-87.6298!3d41.8781!3m2!1i1024!2i768!4f13.1!7i20!10b1!24m107!1m25!13m9!2b1!3b1!4b1!6i1!8b1!9b1!14b1!20b1!25b1!18m14!3b1!4b1!5b1!6b1!13b1!14b1!17b1!21b1!22b1!32b1!33m1!1b1!34b1!36e2!10m1!8e3!11m1!3e1!17b1!20m2!1e3!1e6!24b1!25b1!26b1!27b1!29b1!30m1!2b1!36b1!37b1!39m3!2m2!2i1!3i1!43b1!52b1!54m1!1b1!55b1!56m1!1b1!61m2!1m1!1e1!65m5!3m4!1m3!1m2!1i224!2i298!72m22!1m8!2b1!5b1!7b1!12m4!1b1!2b1!4m1!1e1!4b1!8m10!1m6!4m1!1e1!4m1!1e3!4m1!1e4!3sother_user_google_review_posts__and__hotel_and_vr_partner_review_posts!6m1!1e1!9b1!89b1!90m2!1m1!1e2!98m3!1b1!2b1!3b1!103b1!113b1!114m3!1b1!2m1!1b1!117b1!122m1!1b1!126b1!127b1!128m1!1b1!26m4!2m3!1i80!2i92!4i8!37m1!1e81';
  const FOV = 13.1;                  // vertical fov in the pb (!4f)
  const LIMIT = 8;                   // requests in flight across a run
  const MAX_PAGES = 10;              // 20 a page; Maps stops at ~100-120
  const MAX_HUBS = 20;              // x ~6 pages x LIMIT is the ceiling: hammering it from an anonymous browser gets 429s
  const CACHE_TTL = 30 * 60e3;
  const CACHE_MAX = 3.5e6;           // chars of sessionStorage for the cache
  const ANCHOR_COLOR = '#ea4335';
  const FIND_COLORS = ['#4285f4', '#34a853', '#fbbc04', '#a142f4', '#12b5cb'];
  const RADII = [0.25, 0.5, 1, 1.5, 2, 5];
  const STARS = [0, 3.5, 3.8, 3.9, 4, 4.2, 4.5, 4.7];
  const REVIEWS = [0, 6, 20, 50, 100, 500];
  const OPEN = [-1, 0, 60, 120, 240];
  const K = { cfg: 'gmLayers.cfg', res: 'gmLayers.res2', cache: 'gmLayers.cache', home: 'gmLayers.home' };
  // Maps only loads a subset of its own "Google Symbols" font (bookmarks, view_list, local_pizza
  // were missing), so pull Material Symbols for exactly the icons used here; Google Symbols is the fallback.
  const ICON_CSS = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400..500,0..1,0&icon_names=add,arrow_drop_down,bakery_dining,bookmarks,check,check_box,check_box_outline_blank,chevron_left,chevron_right,close,crop_free,delete,directions,edit,ev_station,expand_less,expand_more,home,hotel,layers,local_bar,local_cafe,local_gas_station,local_pizza,location_on,lunch_dining,my_location,open_in_new,park,restaurant,reviews,schedule,search,shopping_cart,star,stop,view_carousel,view_list&display=block';
  const PRESETS = [
    { name: 'Superchargers + food', anchor: 'tesla supercharger', finds: ['food'], radius: 0.5 },
    { name: 'Superchargers + coffee', anchor: 'tesla supercharger', finds: ['coffee'], radius: 0.5 },
    { name: 'Hotels + dog parks', anchor: 'hotel', finds: ['dog park'], radius: 1 },
    { name: 'Gas + coffee', anchor: 'gas station', finds: ['coffee'], radius: 0.25 },
  ];

  // ======================================================================== PURE
  const PURE = (() => {
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    function miles(a, b) {
      const t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lng - a.lng) * t;
      const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2;
      return 2 * 3958.8 * Math.asin(Math.sqrt(h));
    }
    function clockAfter(base, hh, mm, ap) {   // next hh:mm AM/PM at or after base
      const t = new Date(base);
      t.setHours((+hh % 12) + (ap === 'PM' ? 12 : 0), +(mm || 0), 0, 0);
      if (t < base) t.setDate(t.getDate() + 1);
      return t;
    }
    // hours text is Google's at search time (`at`): "Open · Closes 3 PM" is closed after 3
    function minsToOpen(h, at, now) {
      if (!h) return null;
      at = new Date(at);
      if (/^(Open(?!s)|Closes soon|Closing soon)/.test(h)) {
        const c = h.match(/Closes (?:soon\s*·\s*)?(\d{1,2})(?::(\d\d))?\s*(AM|PM)/);
        return c && clockAfter(at, c[1], c[2], c[3]) <= now ? null : 0;
      }
      const m = h.match(/Opens (?:soon\s*·\s*)?(\d{1,2})(?::(\d\d))?\s*(AM|PM)(?:\s+(\w{3}))?/);
      if (!m) return null;
      if (m[4] && m[4] !== DAYS[at.getDay()]) return Infinity;
      return Math.max(0, (clockAfter(at, m[1], m[2], m[3]) - now) / 60000);
    }
    // openings sit on a :00/:30 grid: a cutoff 15+ min past a mark stretches to the
    // next mark (2:45 + 1 h -> 4:00, 2:44 -> 3:44). Never for "now" (w = 0).
    function cutoffMins(w, now) {
      if (w <= 0) return w;
      const d = new Date(now), rem = (d.getMinutes() + d.getSeconds() / 60) % 30;
      return w + (rem >= 15 ? 30 - rem : 0);
    }
    const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
    const queryText = (q) => { const m = q.match(/^\s*"(.+)"\s*$/); return m ? m[1] : q; };
    // a place matches when every query word is in its name or category ("Subway54763" too)
    function matches(p, q) {
      const hay = norm(p.name + ' ' + p.cat), flat = hay.replace(/ /g, '');
      return norm(queryText(q)).split(' ').every((w) => hay.includes(w) || flat.includes(w));
    }
    // Maps pads results with loosely related places ("subway" -> Publix, "dog park" ->
    // a sports bar). Category-like queries match 76-97% of hits by name/category
    // (coffee, pizza, gas station, gym, hotel), free-text ones 28-45% (food, tacos,
    // dog park) where the rest are real answers - so trim only above 75%, or always
    // when the query is "quoted" or marked exact. Measured on 2 areas, n=120-202 each.
    function relevant(list, q, exact) {
      const m = list.filter((p) => matches(p, q));
      return (exact || /^\s*".+"\s*$/.test(q) || m.length >= list.length * 0.75) ? m : list;
    }
    function glyph(cat) {
      const c = (cat || '').toLowerCase();
      return /charg/.test(c) ? 'ev_station' : /coffee|caf|tea /.test(c) ? 'local_cafe'
        : /pizza/.test(c) ? 'local_pizza' : /\bbar\b|\bpub\b|brew|wine|kava|cocktail/.test(c) ? 'local_bar'
        : /bakery|donut|dessert|ice cream|frozen/.test(c) ? 'bakery_dining' : /hotel|motel|inn|lodg|resort/.test(c) ? 'hotel'
        : /gas station/.test(c) ? 'local_gas_station' : /grocery|supermarket|market/.test(c) ? 'shopping_cart'
        : /park/.test(c) ? 'park' : /fast food|burger|sandwich/.test(c) ? 'lunch_dining'
        : /restaurant|food|grill|diner|taco|sushi|chicken|steak|bbq|kitchen|eatery/.test(c) ? 'restaurant' : 'location_on';
    }
    return { miles, minsToOpen, cutoffMins, relevant, matches, queryText, glyph };
  })();
  const { miles } = PURE;

  // ======================================================================= STORE
  const store = {
    load(area, k, d) { try { const v = JSON.parse(area.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    save(area, k, v) { try { area.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  function loadCfg() {
    const c = store.load(localStorage, K.cfg, {});
    if (Array.isArray(c.layers) && c.anchor === undefined) {   // v1 shape: layers[0] = anchor
      c.anchor = c.layers[0] || ''; c.finds = c.layers.slice(1).filter(Boolean);
    }
    return Object.assign({ anchor: 'tesla supercharger', finds: ['food'], radius: 0.5, openWithin: -1,
      minStars: 3.9, minReviews: 6, sheet: 'cards', hidden: false, presets: [], exact: {} }, c);
  }
  const S = {
    cfg: loadCfg(),
    res: store.load(sessionStorage, K.res, null),   // { at, radius, anchor, finds, hubs:[id], places:{id:p}, near:{hubId:[[fi,id,d]]}, findIds:[[id]] }
    ui: { hub: null, running: false, progress: 0, status: '', editing: null, menu: null, hover: null },
  };
  const home = () => store.load(localStorage, K.home, null);
  function setCfg(patch) { Object.assign(S.cfg, patch); store.save(localStorage, K.cfg, S.cfg); UI.render(); MAP.draw(); }
  function setUI(patch) { Object.assign(S.ui, patch); UI.render(); }

  // ========================================================================= API
  class RateLimited extends Error {}
  const API = (() => {
    let active = 0; const waiting = []; let live = new Set();
    async function limited(fn) {
      if (active >= LIMIT) await new Promise((r) => waiting.push(r));
      active++;
      try { return await fn(); } finally { active--; if (waiting.length) waiting.shift()(); }
    }
    // GM_xmlhttpRequest from the ViolentMonkey sandbox (Maps' CSP blocks page-mode eval);
    // fetch when injected by hand. Both abortable through cancelAll().
    function get(path) {
      return new Promise((ok, bad) => {
        if (typeof GM_xmlhttpRequest === 'function') {
          const handle = { abort: () => req && req.abort && req.abort() };
          const req = GM_xmlhttpRequest({
            url: 'https://www.google.com' + path,
            onload: (r) => { live.delete(handle); r.status === 200 ? ok(r.responseText) : bad(r.status === 429 ? new RateLimited('429') : new Error('HTTP ' + r.status)); },
            onerror: () => { live.delete(handle); bad(new Error('request failed')); },
            onabort: () => { live.delete(handle); bad(new DOMException('aborted', 'AbortError')); },
          });
          live.add(handle);
        } else {
          const ac = new AbortController(), handle = { abort: () => ac.abort() };
          live.add(handle);
          fetch(path, { credentials: 'include', signal: ac.signal }).then((r) => {
            live.delete(handle);
            if (r.status === 429) throw new RateLimited('429');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
          }).then(ok, (e) => { live.delete(handle); bad(e); });
        }
      });
    }
    function cancelAll() { for (const h of live) h.abort(); live = new Set(); waiting.splice(0).forEach((r) => r()); }
    function parse(t) {
      // anything but the )]}' JSON prefix is a captcha / "unusual traffic" page: stop, don't retry
      if (!/^\)\]\}'/.test(t)) throw new RateLimited('non-JSON response');
      const j = JSON.parse(t.replace(/^\)\]\}'\n/, '').replace(/\/\*""\*\/\s*$/, ''));
      const out = [];
      (function walk(a) {
        if (!Array.isArray(a)) return;
        if (typeof a[11] === 'string' && Array.isArray(a[9]) && typeof a[9][2] === 'number' && typeof a[10] === 'string') {
          out.push({
            id: a[10], name: a[11], lat: a[9][2], lng: a[9][3],
            rating: a[4] && a[4][7], reviews: a[4] && a[4][8], price: (a[4] && typeof a[4][2] === 'string') ? a[4][2] : '',
            cat: (a[13] || [])[0] || '', addr: (a[2] || []).join(', '),
            hours: (((a[203] || [])[1] || [])[4] || [])[0] || '', photo: photoOf(a),
          });
          return;
        }
        a.forEach(walk);
      })(j);
      return out;
    }
    function photoOf(a) {   // [37] owner/user photos, [72] street view fallback; each [i][0][6][0]
      for (const k of [37, 72]) {
        const u = (((((a[k] || [])[0] || [])[0] || [])[6] || [])[0]);
        if (typeof u === 'string' && /^https:/.test(u)) return u;
      }
      return '';
    }
    function url(q, lat, lng, dist, w, h, off) {
      const pb = '!1s' + q + PB.replace(/!1d[\d.]+!2d[-\d.]+!3d[-\d.]+/, '!1d' + dist + '!2d' + lng + '!3d' + lat)
        .replace(/!3m2!1i\d+!2i\d+!4f/, '!3m2!1i' + Math.round(w) + '!2i' + Math.round(h) + '!4f')
        .replace('!7i20', '!7i20' + (off ? '!8i' + off : ''));
      return '/search?tbm=map&authuser=0&hl=en&gl=us&q=' + encodeURIComponent(q) + '&pb=' + encodeURIComponent(pb);
    }
    // relevance-ranked, so in-range hits turn up on late pages: page until one is empty
    // (stopping at the first page with nothing new kept 33 of 54 food places at 0.5 mi)
    async function searchAll(q, lat, lng, dist, w, h) {
      const all = [];
      for (let off = 0; off < MAX_PAGES * 20; off += 100) {
        const pages = await Promise.all([0, 20, 40, 60, 80].map((o) => limited(() => get(url(q, lat, lng, dist, w, h, off + o)).then(parse))));
        pages.forEach((pg) => all.push(...pg));
        if (pages.some((pg) => !pg.length)) break;
      }
      const seen = new Map(); for (const p of all) if (!seen.has(p.id)) seen.set(p.id, p);
      return [...seen.values()];
    }
    async function geocode(q, near) {
      const t = await get(url(q, near.lat, near.lng, 50000, 800, 800, 0));
      const m = t.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
      return m ? { lat: +m[1], lng: +m[2] } : null;
    }
    return { searchAll, geocode, cancelAll };
  })();

  // Search cache: identical (query, centre, area) within 30 min is answered from
  // sessionStorage, so re-searching a view you panned back to costs nothing.
  const CACHE = (() => {
    let c = store.load(sessionStorage, K.cache, { q: {}, places: {} });
    const key = (q, lat, lng, dist) => q + '|' + lat.toFixed(4) + ',' + lng.toFixed(4) + '|' + Math.round(dist);
    function get(q, lat, lng, dist) {
      const e = c.q[key(q, lat, lng, dist)];
      return e && Date.now() - e.at < CACHE_TTL ? e.ids.map((id) => c.places[id]).filter(Boolean) : null;
    }
    function put(q, lat, lng, dist, list) {
      c.q[key(q, lat, lng, dist)] = { at: Date.now(), ids: list.map((p) => p.id) };
      for (const p of list) c.places[p.id] = p;
    }
    function flush() {
      let s = JSON.stringify(c);
      while (s.length > CACHE_MAX && Object.keys(c.q).length) {   // evict oldest, then orphaned places
        const oldest = Object.entries(c.q).sort((a, b) => a[1].at - b[1].at).slice(0, 5);
        oldest.forEach(([k]) => delete c.q[k]);
        const keep = new Set(Object.values(c.q).flatMap((e) => e.ids));
        for (const id of Object.keys(c.places)) if (!keep.has(id)) delete c.places[id];
        s = JSON.stringify(c);
      }
      try { sessionStorage.setItem(K.cache, s); } catch (e) { c = { q: {}, places: {} }; }
    }
    function clear() { c = { q: {}, places: {} }; flush(); }
    return { get, put, flush, clear };
  })();
  async function cachedSearch(q, lat, lng, dist, w, h, stats) {
    const hit = CACHE.get(q, lat, lng, dist);
    if (hit) { stats.cached++; return hit; }
    const list = await API.searchAll(PURE.queryText(q), lat, lng, dist, w, h);
    CACHE.put(q, lat, lng, dist, list);
    stats.fetched++;
    return list;
  }

  // ====================================================================== ENGINE
  const ENGINE = (() => {
    let gen = 0;
    function cancel(msg) {
      gen++; API.cancelAll();
      setUI({ running: false, progress: 0, status: msg || 'Cancelled' });
    }
    async function run() {
      const v = MAP.view();
      if (!v) return setUI({ status: 'Pan the map once so its position is in the URL' });
      const cfg = S.cfg, finds = cfg.finds.filter(Boolean);
      if (!finds.length) return setUI({ status: 'Add something to find' });
      const my = ++gen, live = () => my === gen;
      API.cancelAll();
      const R = cfg.radius, stats = { cached: 0, fetched: 0 };
      const dist = v.mpp * v.r.height / (2 * Math.tan(FOV / 2 * Math.PI / 180));
      const halfW = v.mpp * v.r.width / 2, halfH = v.mpp * v.r.height / 2;
      const inView = (p) => Math.abs(p.lat - v.lat) * 111320 <= halfH &&
        Math.abs(p.lng - v.lng) * 111320 * Math.cos(v.lat * Math.PI / 180) <= halfW;
      const r = { at: Date.now(), radius: R, anchor: cfg.anchor, finds, hubs: [], places: {}, near: {}, findIds: finds.map(() => []) };
      const add = (p) => { r.places[p.id] = p; return p.id; };
      setUI({ running: true, progress: 0.02, status: 'Finding ' + (cfg.anchor || finds[0]) + '…' });
      try {
        if (cfg.anchor) {
          const anchors = PURE.relevant(await cachedSearch(cfg.anchor, v.lat, v.lng, dist, v.r.width, v.r.height, stats), cfg.anchor, cfg.exact[cfg.anchor]).filter(inView);
          if (!live()) return;
          // two results on one lot (Supercharger + Destination Charger) are one hub
          const hubs = [], hm = home(), c0 = hm || { lat: v.lat, lng: v.lng };
          anchors.sort((x, y) => miles(c0, x) - miles(c0, y));   // the cap keeps the nearest
          for (const a of anchors) if (hubs.length < MAX_HUBS && !hubs.some((b) => miles(a, b) < 0.15)) hubs.push(a);
          r.hubs = hubs.map(add);
          r.capped = anchors.length > hubs.length ? anchors.length : 0;
          S.res = r; MAP.draw(); UI.render();
          const d = 6000 * R;   // pb !1d 3000 for 0.5 mi found the most in range (800/1500/3000/5000 tried)
          let done = 0; const total = hubs.length * finds.length;
          await Promise.all(finds.flatMap((q, fi) => hubs.map(async (a) => {
            const list = PURE.relevant(await cachedSearch(q, a.lat, a.lng, d, 800, 800, stats), q, cfg.exact[q]).filter((p) => miles(a, p) <= R + 0.15);
            if (!live()) return;
            for (const p of list) if (!r.hubs.includes(p.id)) { add(p); if (!r.findIds[fi].includes(p.id)) r.findIds[fi].push(p.id); }
            // this hub's own hits now, so dots and counts fill in while the rest search;
            // the full table at the end also picks up places found by neighbouring hubs
            const mine = list.filter((p) => !r.hubs.includes(p.id)).map((p) => [fi, p.id, +miles(a, p).toFixed(3)]).filter((x) => x[2] <= R);
            r.near[a.id] = (r.near[a.id] || []).filter((x) => x[0] !== fi).concat(mine).sort((x, y) => x[2] - y[2]);
            done++;
            setUI({ progress: done / total, status: 'Searching ' + done + ' of ' + total + ' · ' + Object.keys(r.places).length + ' places' });
            MAP.draw();
          })));
        } else {
          for (let fi = 0; fi < finds.length; fi++) {
            const list = PURE.relevant(await cachedSearch(finds[fi], v.lat, v.lng, dist, v.r.width, v.r.height, stats), finds[fi], cfg.exact[finds[fi]]).filter(inView);
            if (!live()) return;
            r.findIds[fi] = list.map(add);
          }
        }
        if (!live()) return;
        // near table: every find within R of each hub, nearest first
        for (const hid of r.hubs) {
          const a = r.places[hid], nb = [];
          r.findIds.forEach((ids, fi) => { for (const id of ids) { const dd = miles(a, r.places[id]); if (dd <= R) nb.push([fi, id, +dd.toFixed(3)]); } });
          r.near[hid] = nb.sort((x, y) => x[2] - y[2]);
        }
        if (r.hubs.length) {   // drop finds near no hub
          const keep = new Set(Object.values(r.near).flatMap((nb) => nb.map((x) => x[1])));
          r.findIds = r.findIds.map((ids) => ids.filter((id) => keep.has(id)));
        }
        S.res = r;
        store.save(sessionStorage, K.res, r) || store.save(sessionStorage, K.res, null);
        CACHE.flush();
        setUI({ running: false, progress: 0, hub: null,
          status: (r.capped ? 'Searched the nearest ' + r.hubs.length + ' of ' + r.capped + ' - zoom in for the rest. ' : '') + (stats.fetched ? '' : 'From cache.') });
        if (S.ui.status) { const st = S.ui.status; setTimeout(() => { if (S.ui.status === st) setUI({ status: '' }); }, 5000); }
        MAP.draw();
      } catch (e) {
        if (!live()) return;
        if (e instanceof RateLimited) cancel('Google is rate-limiting this browser - wait a few minutes before searching again');
        else if (e && e.name === 'AbortError') return;
        else cancel('Search failed: ' + e.message);
      }
    }
    return { run, cancel, running: () => S.ui.running };
  })();

  // ====================================================================== FILTERS
  const F = {
    // radius narrows instantly; growing past what was searched re-searches
    radius() { return S.res ? Math.min(S.cfg.radius, S.res.radius || Infinity) : S.cfg.radius; },
    place(p) {
      const c = S.cfg;
      if (c.minStars > 0 && !((p.rating || 0) >= c.minStars)) return false;
      if ((p.reviews || 0) < (c.minReviews || 0)) return false;
      if (c.openWithin >= 0) {
        const m = PURE.minsToOpen(p.hours, S.res ? S.res.at : Date.now(), Date.now());
        if (m === null || m > PURE.cutoffMins(c.openWithin, Date.now())) return false;
      }
      return true;
    },
    hubPlaces(hid) {   // [[fi, place, d]] passing filters, within the live radius
      const R = F.radius();
      return ((S.res && S.res.near[hid]) || []).filter((x) => x[2] <= R).map(([fi, id, d]) => [fi, S.res.places[id], d]).filter((x) => x[1] && F.place(x[1]));
    },
    hubs() {   // [{hub, d, list}] sorted by distance from home, else map centre
      if (!S.res) return [];
      const h = home(), v = MAP.view(), c = h || (v ? { lat: v.lat, lng: v.lng } : null);
      return S.res.hubs.map((id) => S.res.places[id]).filter(Boolean)
        .map((a) => ({ hub: a, d: c ? miles(c, a) : 0, list: F.hubPlaces(a.id) })).sort((x, y) => x.d - y.d);
    },
  };
  const openLabel = (w) => w < 0 ? 'Any time' : w === 0 ? 'Open now' : 'Open by ' +
    new Date(Date.now() + PURE.cutoffMins(w, Date.now()) * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const placeUrl = (p) => 'https://www.google.com/maps?cid=' + BigInt(p.id.split(':')[1]).toString();
  const dirUrl = (p) => 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lng;
  const sized = (u, w, h) => /googleusercontent/.test(u) ? u.replace(/=[^/=]*$/, '') + '=w' + w + '-h' + h + '-k-no' : u;
  const isOpen = (h) => /^(Open(?!s)|Closes soon|Closing soon)/.test(h || '');

  // ========================================================================= DOM
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
    return e;
  }
  const icon = (name, cls) => h('span', { class: 'gl-i' + (cls ? ' ' + cls : '') }, name);
  const starsEl = (r) => r ? h('span', { class: 'gl-stars' }, '★'.repeat(Math.round(r))) : null;

  // ========================================================================= MAP
  const MAP = (() => {
    const svgNS = 'http://www.w3.org/2000/svg';
    const ov = h('div', { id: 'gl-ov' });
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    ov.append(svg);
    function canvas() {
      let best = null;
      for (const c of document.querySelectorAll('canvas')) {
        const r = c.getBoundingClientRect();
        if (!best || r.width * r.height > best.a) best = { c, a: r.width * r.height };
      }
      return best && best.a > 1e5 ? best.c : null;
    }
    // @lat,lng,{zoom}z  or  @lat,lng,{N}m  where N ~ metres top-to-bottom (scale bar agreed to 0.3%)
    function view() {
      const m = location.pathname.match(/@(-?[\d.]+),(-?[\d.]+),([\d.]+)([zm])/), c = canvas();
      if (!m || !c) return null;
      const r = c.getBoundingClientRect(), lat = +m[1], lng = +m[2], v = +m[3];
      const mpp = m[4] === 'z' ? 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, v) : v / r.height;
      return { lat, lng, mpp, r };
    }
    const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    function project(v, lat, lng) {
      const k = Math.cos(v.lat * Math.PI / 180) * 6378137 / v.mpp;
      return [v.r.left + v.r.width / 2 + (lng - v.lng) * Math.PI / 180 * k, v.r.top + v.r.height / 2 + (mercY(v.lat) - mercY(lat)) * k];
    }
    function leftEdge(v) {   // results pane, and the icon rail (no role to find it by)
      const side = document.querySelector('div[role="main"]');
      let left = side ? Math.max(v.r.left, side.getBoundingClientRect().right) : v.r.left;
      for (let e = document.elementFromPoint(2, innerHeight / 2); e && e !== document.body; e = e.parentElement) {
        const r = e.getBoundingClientRect();
        if (r.left <= 1 && r.width < 200 && r.height > innerHeight * 0.8) left = Math.max(left, r.right);
      }
      return left;
    }
    const el = (tag, a) => { const e = document.createElementNS(svgNS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };
    function draw() {
      svg.textContent = '';
      const v = view();
      if (!v || S.cfg.hidden) return;
      const left = leftEdge(v), bottom = UI.sheetTop();
      UI.place(left);
      ov.style.clipPath = 'inset(0 0 ' + Math.max(0, innerHeight - bottom) + 'px ' + left + 'px)';
      const inside = ([x, y], m) => x > left - m && y > -m && x < innerWidth + m && y < bottom + m;
      const hm = home();
      if (S.res) {
        const hubs = F.hubs(), sel = UI.selectedHub(hubs), R = F.radius(), rpx = R * 1609.34 / v.mpp;
        // radius discs: one translucent group so overlaps merge instead of darkening
        const g = el('g', { opacity: '0.12' }), ring = el('g', { opacity: '0.5', fill: 'none', stroke: ANCHOR_COLOR, 'stroke-width': '1.5', 'stroke-dasharray': '6 4' });
        for (const x of hubs) {
          const pt = project(v, x.hub.lat, x.hub.lng);
          if (!inside(pt, rpx)) continue;
          g.append(el('circle', { cx: pt[0], cy: pt[1], r: rpx, fill: ANCHOR_COLOR }));
          ring.append(el('circle', { cx: pt[0], cy: pt[1], r: rpx }));
        }
        svg.append(g, ring);
        // finds: the selected hub's at full strength with icons, the rest as small dots
        const selIds = new Set(sel ? sel.list.map((x) => x[1].id) : []);
        const drawn = new Set(), dots = [];
        for (const x of hubs) for (const [fi, p] of x.list) {
          if (drawn.has(p.id)) continue; drawn.add(p.id);
          const pt = project(v, p.lat, p.lng);
          if (inside(pt, 20)) dots.push([fi, p, pt, selIds.has(p.id)]);
        }
        const big = dots.filter((d) => d[3]).length <= 250;
        dots.sort((a, b) => a[3] - b[3]);   // selected on top
        for (const [fi, p, [x, y], isSel] of dots) {
          const gg = el('g', { 'data-id': p.id, class: 'gl-dot' + (isSel ? ' sel' : '') + (S.ui.hover === p.id ? ' hov' : '') });
          const r = isSel && big ? 10 : 5;
          gg.append(el('circle', { cx: x, cy: y, r, fill: FIND_COLORS[fi % FIND_COLORS.length], stroke: '#fff', 'stroke-width': isSel ? 1.5 : 1, opacity: isSel ? 1 : 0.55 }));
          if (isSel && big) { const t = el('text', { x, y: y + 6, class: 'gl-g' }); t.textContent = PURE.glyph(p.cat); gg.append(t); }
          svg.append(gg);
        }
        for (const x of hubs) {
          const pt = project(v, x.hub.lat, x.hub.lng);
          if (!inside(pt, 20)) continue;
          const isSel = sel && sel.hub.id === x.hub.id;
          const gg = el('g', { 'data-id': x.hub.id, 'data-hub': '1', class: 'gl-dot gl-hubm' + (isSel ? ' sel' : '') });
          gg.append(el('circle', { cx: pt[0], cy: pt[1], r: isSel ? 15 : 12, fill: ANCHOR_COLOR, stroke: '#fff', 'stroke-width': 2 }));
          const t = el('text', { x: pt[0], y: pt[1] + (isSel ? 8 : 7), class: 'gl-g', style: 'font-size:' + (isSel ? 16 : 14) + 'px' });
          t.textContent = PURE.glyph(x.hub.cat || 'charg'); gg.append(t);
          if (x.list.length) {
            const bx = pt[0] + 11, by = pt[1] - 11;
            gg.append(el('rect', { x: bx - 2, y: by - 8, width: String(x.list.length).length * 7 + 8, height: 16, rx: 8, fill: '#202124', stroke: '#fff', 'stroke-width': 1 }));
            const n = el('text', { x: bx + 2, y: by + 4, class: 'gl-n' }); n.textContent = x.list.length; gg.append(n);
          }
          svg.append(gg);
        }
      }
      if (hm) {
        const pt = project(v, hm.lat, hm.lng);
        if (inside(pt, 20)) {
          const gg = el('g', { class: 'gl-home' });
          gg.append(el('circle', { cx: pt[0], cy: pt[1], r: 12, fill: '#202124', stroke: '#fff', 'stroke-width': 2 }));
          const t = el('text', { x: pt[0], y: pt[1] + 7, class: 'gl-g', style: 'font-size:15px' }); t.textContent = 'home'; gg.append(t);
          svg.append(gg);
        }
      }
    }
    svg.addEventListener('click', (e) => {
      const g = e.target.closest('[data-id]'); if (!g) return;
      if (g.dataset.hub) return UI.selectHub(g.dataset.id, true);
      const p = S.res && S.res.places[g.dataset.id]; if (p) window.open(placeUrl(p), '_blank');
    });
    svg.addEventListener('mouseover', (e) => { const g = e.target.closest('[data-id]'); if (g) UI.card(S.res.places[g.dataset.id], g.getBoundingClientRect()); });
    svg.addEventListener('mouseout', (e) => { if (e.target.closest('[data-id]')) UI.cardHideSoon(); });
    return { ov, draw, view, canvas };
  })();

  // ========================================================================== UI
  const UI = (() => {
    const css = h('style', null, `
#gl-ov{position:fixed;inset:0;pointer-events:none;z-index:2}
/* while Map Layers is open its bar takes the top-left: Google's own search box and
   category chips step aside - their wrappers too, which otherwise eat map drags along the top
   (visibility, not display, so Maps' layout code is undisturbed).
   x (hide) brings them back. */
.gl-active div:has(> div > div > [role="search"]),.gl-active div:has(> div > [role="region"][aria-label^="Available search options"]){visibility:hidden!important}
#gl-ov svg{position:absolute;inset:0}
.gl-dot{pointer-events:auto;cursor:pointer}.gl-dot.hov circle{stroke:#000;stroke-width:3}
.gl-g{font-family:"Material Symbols Rounded","Google Symbols";font-size:13px;fill:#fff;text-anchor:middle;pointer-events:none}
.gl-n{font:600 10px "Google Sans",Roboto,sans-serif;fill:#fff;pointer-events:none}
#gl-root,.gl-menu{--bg:#202124;--s1:#28292c;--s2:#303134;--s3:#3c4043;--t1:#e8eaed;--t2:#9aa0a6;--acc:#8ab4f8;--accbg:#394457;--grn:#81c995;--red:#f28b82;--ylw:#fdd663;
  font:13px/1.4 Roboto,Arial,sans-serif;color:var(--t1)}
#gl-root *{box-sizing:border-box}
.gl-i{font-family:"Material Symbols Rounded","Google Symbols";font-size:20px;line-height:1;vertical-align:middle;font-weight:normal;font-style:normal;letter-spacing:normal;white-space:nowrap;direction:ltr;-webkit-font-feature-settings:"liga"}
.gl-bar{position:fixed;z-index:1000;top:12px;display:flex;align-items:center;gap:6px;background:var(--bg);border-radius:26px;box-shadow:0 2px 12px #0009;padding:6px 6px 6px 14px;font:15px "Google Sans",Roboto,sans-serif;max-width:calc(100vw - 120px)}
.gl-sent{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--t2);min-width:0}
.gl-tok{display:inline-flex;align-items:center;gap:5px;background:var(--s2);border-radius:8px;padding:4px 9px;cursor:pointer;color:var(--t1);font-weight:500;border:0;font:500 14px "Google Sans",Roboto,sans-serif}
.gl-tok:hover{background:var(--s3)}.gl-tok .x{color:var(--t2);font-size:16px;margin-right:-3px}.gl-tok .x:hover{color:var(--t1)}
.gl-tok input{background:none;border:0;outline:0;color:var(--t1);font:inherit;width:9em}
.gl-dotc{width:10px;height:10px;border-radius:50%;flex:none}
.gl-ibtn{width:36px;height:36px;border-radius:50%;border:0;background:transparent;color:var(--t2);display:inline-grid;place-items:center;cursor:pointer;flex:none}
.gl-ibtn:hover{background:var(--s2);color:var(--t1)}
.gl-go{height:38px;min-width:38px;border-radius:19px;border:0;background:var(--acc);color:#202124;display:inline-flex;align-items:center;gap:6px;padding:0 14px;font:500 14px "Google Sans",Roboto,sans-serif;cursor:pointer;flex:none}
.gl-go.stop{background:var(--s3);color:var(--t1)}
.gl-chips{position:fixed;z-index:999;top:68px;display:flex;gap:6px;flex-wrap:wrap}
.gl-chip{display:inline-flex;align-items:center;gap:4px;height:32px;padding:0 12px;border-radius:16px;border:1px solid var(--s3);background:var(--bg);color:var(--t1);font:500 13px "Google Sans",Roboto,sans-serif;cursor:pointer;box-shadow:0 1px 4px #0008}
.gl-chip.on{background:var(--accbg);border-color:var(--accbg);color:#d2e3fc}.gl-chip .gl-i{font-size:18px}
.gl-menu{position:fixed;z-index:1002;color:var(--t1);font:13px/1.4 Roboto,Arial,sans-serif;overflow-x:hidden;white-space:nowrap;background:var(--bg);border-radius:10px;box-shadow:0 6px 24px #000c;padding:6px 0;min-width:180px;max-height:60vh;overflow:auto}
.gl-menu .it{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;font:14px "Google Sans",Roboto,sans-serif}
.gl-menu .it:hover{background:var(--s2)}.gl-menu .it.on{color:var(--acc)}
.gl-menu .sep{height:1px;background:var(--s3);margin:6px 0}.gl-menu .hd{padding:6px 14px 2px;font:500 11px "Google Sans";color:var(--t2);text-transform:uppercase;letter-spacing:.6px}
.gl-menu input{margin:4px 12px 8px;width:calc(100% - 24px);background:var(--s1);border:1px solid var(--s3);border-radius:8px;padding:8px 10px;color:var(--t1);font:14px "Google Sans",Roboto,sans-serif;outline:0}
.gl-sheet{position:fixed;z-index:998;bottom:0;background:var(--bg);border-radius:16px 16px 0 0;box-shadow:0 -4px 20px #000a;display:flex;flex-direction:column;transition:height .2s ease}
.gl-grab{height:22px;display:grid;place-items:center;cursor:ns-resize;flex:none;touch-action:none}.gl-grab i{width:40px;height:4px;border-radius:2px;background:var(--s3)}
.gl-prog{height:3px;background:var(--s2);margin:0 16px;border-radius:2px;overflow:hidden;flex:none}.gl-prog i{display:block;height:100%;background:var(--acc);transition:width .2s}
.gl-status{padding:2px 16px 4px;color:var(--t2);font-size:12px;min-height:18px;flex:none;display:flex;gap:8px;align-items:center}
.gl-status .sp{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gl-sbtn{height:32px;border-radius:16px;border:1px solid var(--s3);background:var(--s1);color:var(--t1);display:inline-flex;align-items:center;gap:4px;padding:0 12px;font:500 13px "Google Sans",Roboto,sans-serif;cursor:pointer}
.gl-sbtn:hover{background:var(--s2)}.gl-sbtn .gl-i{font-size:19px}
.gl-hubs{display:flex;gap:8px;overflow-x:auto;padding:4px 12px 8px;scrollbar-width:none;flex:none;align-items:stretch}
.gl-nav{flex:none;width:44px;border-radius:12px;border:0;background:var(--s1);color:var(--t1);cursor:pointer;display:grid;place-items:center}
.gl-nav:hover{background:var(--s2)}
.gl-hub{flex:none;min-width:150px;padding:9px 12px;border-radius:12px;background:var(--s1);cursor:pointer;border:2px solid transparent;text-align:left;color:var(--t1)}
.gl-hub:hover{background:var(--s2)}.gl-hub.on{background:var(--accbg);border-color:var(--acc)}
.gl-hub .t{font:500 14px "Google Sans",Roboto,sans-serif;display:flex;align-items:center;gap:6px;white-space:nowrap}
.gl-hub .s{font-size:12px;color:var(--t2);white-space:nowrap;margin-top:2px;max-width:240px;overflow:hidden;text-overflow:ellipsis}
.gl-hub.none{opacity:.55}
.gl-i.f{font-variation-settings:"FILL" 1}
.gl-cards{display:flex;gap:10px;overflow-x:auto;padding:2px 12px 12px;scroll-snap-type:x proximity;flex:1;align-items:stretch;scrollbar-width:thin;scrollbar-color:var(--s3) transparent}
.gl-card{flex:none;width:210px;background:var(--s1);border-radius:14px;overflow:hidden;cursor:pointer;scroll-snap-align:start;display:flex;flex-direction:column}
.gl-card:hover,.gl-card.hov{background:var(--s2);outline:2px solid var(--acc)}
.gl-card .ph{height:112px;background:var(--s3) center/cover;position:relative;flex:none}
.gl-card .ph .d{position:absolute;left:8px;bottom:8px;background:#000b;color:#fff;border-radius:10px;padding:2px 8px;font:500 12px "Google Sans"}
.gl-card .cb{padding:8px 11px 10px;display:flex;flex-direction:column;gap:2px;flex:1}
.gl-card .nm{font:500 14px "Google Sans",Roboto,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gl-card .mt{font-size:12.5px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gl-card .acts{display:flex;gap:6px;margin-top:6px}
.gl-act{flex:1;height:32px;border-radius:16px;border:1px solid var(--s3);background:transparent;color:var(--acc);display:inline-flex;align-items:center;justify-content:center;gap:4px;font:500 12.5px "Google Sans";cursor:pointer}
.gl-act:hover{background:var(--s2)}
.gl-stars{color:var(--ylw);letter-spacing:-1px;font-size:12px}
.gl-open{color:var(--grn)}.gl-closed{color:var(--red)}.gl-dim{color:var(--t2)}
.gl-empty{padding:18px 16px;color:var(--t2);font:14px "Google Sans"}
.gl-list{flex:1;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--s3) transparent}
.gl-lhd{display:flex;align-items:center;gap:8px;padding:6px 16px 8px;color:var(--t2);font-size:12px;flex:none;border-bottom:1px solid var(--s3)}
.gl-lhd b{color:var(--t1);font:500 13px "Google Sans"}
.gl-seg{display:inline-flex;background:var(--s1);border-radius:8px;padding:2px;margin-left:auto}
.gl-seg span{padding:4px 10px;border-radius:6px;cursor:pointer;font:500 12px "Google Sans"}.gl-seg span.on{background:var(--s3);color:var(--t1)}
.gl-row{display:grid;grid-template-columns:44px 1fr auto auto;gap:10px;align-items:center;padding:6px 16px;border-bottom:1px solid #2a2b2e;cursor:pointer}
.gl-row:hover,.gl-row.hov{background:var(--s2)}
.gl-row .th{width:44px;height:44px;border-radius:8px;background:var(--s3) center/cover}
.gl-row .nm{font:500 13.5px "Google Sans",Roboto,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gl-row .mt{font-size:12px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gl-row .num{font:500 12.5px "Google Sans";color:var(--t2);text-align:right;white-space:nowrap}
.gl-row.hubrow{position:sticky;top:0;z-index:1;background:var(--s1);grid-template-columns:44px 1fr auto auto}
.gl-row.hubrow .th{background:${ANCHOR_COLOR};display:grid;place-items:center;color:#fff}
.gl-pill{position:fixed;z-index:1000;bottom:16px;display:flex;align-items:center;gap:8px;background:var(--bg);border-radius:22px;box-shadow:0 2px 12px #0009;padding:6px 14px 6px 8px;cursor:pointer;font:500 14px "Google Sans",Roboto,sans-serif}
.gl-card-pop{position:fixed;z-index:1003;width:300px;background:var(--bg);border-radius:12px;overflow:hidden;box-shadow:0 6px 24px #000c}
.gl-card-pop .ph{height:150px;background:var(--s3) center/cover}
.gl-card-pop .cb{padding:10px 12px 12px;display:flex;flex-direction:column;gap:2px}
.gl-card-pop .nm{font:500 15px "Google Sans",Roboto,sans-serif}
.gl-card-pop .acts{display:flex;gap:6px;margin-top:8px}
`);
    const root = h('div', { id: 'gl-root' });
    let cardEl = null, cardTimer = 0, scrollMemo = {};
    const SHEET_H = { min: 128, cards: 392, list: () => Math.round(innerHeight * 0.66) };

    function sheetH() { const s = S.cfg.sheet; return typeof SHEET_H[s] === 'function' ? SHEET_H[s]() : SHEET_H[s]; }
    function sheetTop() { return S.cfg.hidden || !S.res ? innerHeight : innerHeight - sheetH(); }
    let leftPx = 80;
    function place(left) {
      if (Math.abs(left - leftPx) < 1) return;
      leftPx = left; render();
    }
    function selectedHub(hubs) {
      hubs = hubs || F.hubs();
      return hubs.find((x) => x.hub.id === S.ui.hub) || hubs[0] || null;
    }
    function selectHub(id, fromMap) {
      S.ui.hub = id;
      if (fromMap && S.cfg.sheet === 'min') S.cfg.sheet = 'cards';
      scrollMemo.cards = 0;
      render(); MAP.draw();
      const t = root.querySelector('.gl-hub.on'); if (t) t.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }

    // ---- bar: "food · coffee within 1.5 mi of tesla supercharger"
    function tok(kind, i, value, color, glyphName) {
      if (S.ui.editing === kind + i) {
        const inp = h('input', { value, placeholder: kind === 'anchor' ? 'e.g. tesla supercharger' : 'e.g. tacos',
          onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') { S.ui.editing = null; render(); } },
          onblur: () => commit(false) });
        function commit(go) {
          if (S.ui.editing !== kind + i) return;
          const val = inp.value.trim(); S.ui.editing = null;
          if (kind === 'anchor') S.cfg.anchor = val; else if (val) S.cfg.finds[i] = val; else S.cfg.finds.splice(i, 1);
          setCfg({});
          if (go) ENGINE.run();
        }
        setTimeout(() => { inp.focus(); inp.select(); });
        return h('span', { class: 'gl-tok' }, color ? h('span', { class: 'gl-dotc', style: { background: color } }) : icon(glyphName), inp);
      }
      return h('button', { class: 'gl-tok', title: 'Edit', onclick: (e) => menu('tok', e.currentTarget, { kind, i, value }) },
        color ? h('span', { class: 'gl-dotc', style: { background: color } }) : icon(glyphName, '') ,
        value || h('span', { class: 'gl-dim' }, kind === 'anchor' ? 'anywhere' : '…'),
        kind === 'find' && S.cfg.finds.length > 1 ? h('span', { class: 'gl-i x', title: 'Remove', onclick: (e) => { e.stopPropagation(); S.cfg.finds.splice(i, 1); setCfg({}); } }, 'close') : null);
    }
    function bar() {
      const c = S.cfg;
      const sent = h('div', { class: 'gl-sent' },
        c.finds.map((q, i) => [i ? h('span', null, '·') : null, tok('find', i, q, FIND_COLORS[i % FIND_COLORS.length])]),
        h('button', { class: 'gl-tok', title: 'Find something else too', onclick: () => { c.finds.push(''); setUI({ editing: 'find' + (c.finds.length - 1) }); } }, icon('add')),
        c.anchor ? [h('span', null, 'within'), h('button', { class: 'gl-tok', onclick: (e) => menu('radius', e.currentTarget) }, c.radius + ' mi'), h('span', null, 'of')] : h('span', null, 'in this area near'),
        tok('anchor', 0, c.anchor, null, PURE.glyph(c.anchor)));
      return h('div', { class: 'gl-bar', style: { left: leftPx + 12 + 'px' } },
        icon('layers', 'gl-dim'), sent,
        S.ui.running
          ? h('button', { class: 'gl-go stop', title: 'Stop', onclick: () => ENGINE.cancel() }, icon('stop'), 'Stop')
          : h('button', { class: 'gl-go', title: 'Search this area', onclick: () => ENGINE.run() }, icon('search'), 'Search'),
        h('button', { class: 'gl-ibtn', title: 'Hide Map Layers and bring back Google search', onclick: () => setCfg({ hidden: true }) }, icon('close')));
    }
    function chips() {
      const c = S.cfg;
      const chip = (on, ic, label, kind) => h('button', { class: 'gl-chip' + (on ? ' on' : ''), onclick: (e) => menu(kind, e.currentTarget) }, icon(ic), label, icon('arrow_drop_down'));
      return h('div', { class: 'gl-chips', style: { left: leftPx + 12 + 'px' } },
        chip(c.openWithin >= 0, 'schedule', openLabel(c.openWithin), 'open'),
        chip(c.minStars > 0, 'star', c.minStars ? c.minStars + '+' : 'Any rating', 'stars'),
        chip(c.minReviews > 0, 'reviews', c.minReviews ? c.minReviews + '+ reviews' : 'Any reviews', 'reviews'),
        chip(!!home(), 'home', home() ? 'From home' : 'Set home', 'home'),
        chip(false, 'bookmarks', 'Saved', 'presets'));
    }
    // ---- menus
    function menu(kind, anchorEl, arg) {
      closeMenu();
      const c = S.cfg, m = h('div', { class: 'gl-menu', id: 'gl-menu' });
      const item = (on, label, fn, ic) => h('div', { class: 'it' + (on ? ' on' : ''), onclick: () => { closeMenu(); fn(); } }, ic ? icon(ic) : icon(on ? 'check' : '', ''), label);
      if (kind === 'tok') {
        const { kind: tk, i, value } = arg, q = value;
        m.append(item(false, 'Edit', () => setUI({ editing: tk + i }), 'edit'));
        if (q) m.append(item(!!c.exact[q], 'Only exact matches', () => { c.exact[q] = !c.exact[q]; setCfg({}); if (S.res) ENGINE.run(); }, c.exact[q] ? 'check_box' : 'check_box_outline_blank'));
        if (tk === 'find' && c.finds.length > 1) m.append(item(false, 'Remove', () => { c.finds.splice(i, 1); setCfg({}); }, 'delete'));
        if (tk === 'anchor' && c.anchor) m.append(item(false, 'Search the whole view instead', () => setCfg({ anchor: '' }), 'crop_free'));
      }
      if (kind === 'radius') RADII.forEach((r) => m.append(item(r === c.radius, r + ' mi', () => setRadius(r))));
      if (kind === 'open') OPEN.forEach((w) => m.append(item(w === c.openWithin, openLabel(w), () => setCfg({ openWithin: w }))));
      if (kind === 'stars') STARS.forEach((s) => m.append(item(s === c.minStars, s ? s.toFixed(1) + '+' : 'Any rating', () => setCfg({ minStars: s }))));
      if (kind === 'reviews') REVIEWS.forEach((n) => m.append(item(n === c.minReviews, n ? n + '+ reviews' : 'Any number', () => setCfg({ minReviews: n }))));
      if (kind === 'home') {
        // the typed address goes to Google's search once; only lat/lng is kept
        const inp = h('input', { placeholder: 'Home address…', onkeydown: async (e) => {
          e.stopPropagation();
          if (e.key !== 'Enter' || !inp.value.trim()) return;
          const v = MAP.view(); inp.disabled = true;
          try {
            const p = await API.geocode(inp.value.trim(), v || { lat: 41.88, lng: -87.63 });
            inp.value = '';
            if (!p) { inp.disabled = false; inp.placeholder = 'Not found - try again'; return; }
            store.save(localStorage, K.home, p); closeMenu(); render(); MAP.draw();
          } catch (err) { inp.disabled = false; inp.value = ''; inp.placeholder = 'Lookup failed'; }
        } });
        m.append(h('div', { class: 'hd' }, 'Distances from'), inp);
        m.append(item(false, 'Use the map centre as home', () => { const v = MAP.view(); if (v) store.save(localStorage, K.home, { lat: v.lat, lng: v.lng }); render(); MAP.draw(); }, 'my_location'));
        if (home()) m.append(item(false, 'Forget home (use map centre)', () => { localStorage.removeItem(K.home); render(); MAP.draw(); }, 'delete'));
        setTimeout(() => inp.focus());
      }
      if (kind === 'presets') {
        m.append(h('div', { class: 'hd' }, 'Setups'));
        [...PRESETS, ...c.presets].forEach((p, i) => m.append(h('div', { class: 'it', onclick: () => { closeMenu(); setCfg({ anchor: p.anchor, finds: p.finds.slice(), radius: p.radius }); ENGINE.run(); } },
          icon(PURE.glyph(p.anchor)), h('span', { style: { flex: '1' } }, p.name),
          i >= PRESETS.length ? h('span', { class: 'gl-i gl-dim', title: 'Delete', onclick: (e) => { e.stopPropagation(); c.presets.splice(i - PRESETS.length, 1); setCfg({}); closeMenu(); } }, 'delete') : null)));
        m.append(h('div', { class: 'sep' }));
        const inp = h('input', { placeholder: 'Save current as…', onkeydown: (e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && inp.value.trim()) { c.presets.push({ name: inp.value.trim(), anchor: c.anchor, finds: c.finds.slice(), radius: c.radius }); setCfg({}); closeMenu(); }
        } });
        m.append(inp);
      }
      document.body.append(m);
      const r = anchorEl.getBoundingClientRect();
      m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + 'px';
      m.style.top = r.bottom + 6 + 'px';
      setTimeout(() => document.addEventListener('pointerdown', outside, true));
    }
    function outside(e) { if (!e.target.closest('#gl-menu')) closeMenu(); }
    function closeMenu() { const m = document.getElementById('gl-menu'); if (m) m.remove(); document.removeEventListener('pointerdown', outside, true); }
    function setRadius(r) {
      setCfg({ radius: r });
      if (S.res && S.res.anchor && r > (S.res.radius || Infinity)) {   // results only reach res.radius
        setUI({ status: 'Results reach ' + S.res.radius + ' mi - searching again for ' + r + ' mi…' });
        ENGINE.run();
      }
    }

    // ---- sheet
    const hoursEl = (hrs) => hrs ? h('span', { class: isOpen(hrs) ? 'gl-open' : 'gl-closed' }, hrs.split(' · ')[0]) : null;
    const hoursRest = (hrs) => hrs && hrs.includes(' · ') ? ' · ' + hrs.split(' · ').slice(1).join(' · ') : '';
    const fromLabel = () => home() ? 'from home' : 'from centre';
    function hubTabs(hubs, sel) {
      const box = h('div', { class: 'gl-hubs' });
      // "Tesla Supercharger" x 7 says nothing - show the address then; hotels differ by name
      const sameName = new Set(hubs.map((x) => x.hub.name)).size <= 1;
      hubs.forEach((x) => box.append(h('button', { class: 'gl-hub' + (sel && sel.hub.id === x.hub.id ? ' on' : '') + (x.list.length ? '' : ' none'), onclick: () => selectHub(x.hub.id) },
        h('div', { class: 't' }, h('span', { class: 'gl-i', style: { color: ANCHOR_COLOR, fontSize: '18px' } }, PURE.glyph(x.hub.cat || 'charg')), x.d.toFixed(1) + ' mi ' + fromLabel()),
        h('div', { class: 's' }, x.list.length + ' place' + (x.list.length === 1 ? '' : 's') + ' · ' + (sameName ? (x.hub.addr || x.hub.name).split(',')[0] : x.hub.name)))));
      box.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { box.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
      return box;
    }
    function cardsFor(sel) {
      if (!sel) return h('div', { class: 'gl-empty' }, 'No results here.');
      if (!sel.list.length) return h('div', { class: 'gl-empty' }, 'Nothing within ' + F.radius() + ' mi of this one matches the filters.');
      const box = h('div', { class: 'gl-cards' });
      for (const [fi, p, d] of sel.list) {
        box.append(h('div', { class: 'gl-card' + (S.ui.hover === p.id ? ' hov' : ''), 'data-id': p.id, onclick: () => window.open(placeUrl(p), '_blank'),
          onmouseenter: () => { S.ui.hover = p.id; MAP.draw(); }, onmouseleave: () => { S.ui.hover = null; MAP.draw(); } },
          h('div', { class: 'ph', style: p.photo ? { backgroundImage: 'url("' + sized(p.photo, 420, 224) + '")' } : null },
            h('span', { class: 'd' }, d.toFixed(2) + ' mi')),
          h('div', { class: 'cb' },
            h('div', { class: 'nm', title: p.name }, h('span', { class: 'gl-dotc', style: { background: FIND_COLORS[fi % FIND_COLORS.length], display: 'inline-block', marginRight: '6px' } }), p.name),
            h('div', { class: 'mt' }, p.rating ? [p.rating + ' ', starsEl(p.rating), ' (' + (p.reviews || 0).toLocaleString() + ')'] : 'No rating', p.price ? ' · ' + p.price : ''),
            h('div', { class: 'mt' }, p.cat),
            h('div', { class: 'mt' }, hoursEl(p.hours), hoursRest(p.hours)),
            h('div', { class: 'acts' },
              h('button', { class: 'gl-act', title: 'Directions', onclick: (e) => { e.stopPropagation(); window.open(dirUrl(p), '_blank'); } }, icon('directions'), 'Go'),
              h('button', { class: 'gl-act', title: 'Open in Google Maps', onclick: (e) => { e.stopPropagation(); window.open(placeUrl(p), '_blank'); } }, icon('open_in_new'), 'Open')))));
      }
      box.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { box.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
      box.addEventListener('scroll', () => { scrollMemo.cards = box.scrollLeft; });
      setTimeout(() => { box.scrollLeft = scrollMemo.cards || 0; });
      return box;
    }
    function listView(hubs, sel) {
      const scope = S.ui.listAll ? hubs : (sel ? [sel] : []);
      const sortBy = S.ui.sort || 'dist';
      const total = new Set(hubs.flatMap((x) => x.list.map((y) => y[1].id))).size;
      const head = h('div', { class: 'gl-lhd' },
        h('span', null, h('b', null, String(total)), ' places near ', h('b', null, String(hubs.filter((x) => x.list.length).length)), ' of ' + hubs.length),
        h('span', { class: 'gl-seg' },
          h('span', { class: S.ui.listAll ? '' : 'on', onclick: () => setUI({ listAll: false }) }, 'This one'),
          h('span', { class: S.ui.listAll ? 'on' : '', onclick: () => setUI({ listAll: true }) }, 'All')),
        h('span', { class: 'gl-seg', style: { marginLeft: '6px' } },
          ['dist', 'rating', 'reviews'].map((k) => h('span', { class: sortBy === k ? 'on' : '', onclick: () => setUI({ sort: k }) }, { dist: 'Nearest', rating: 'Rating', reviews: 'Popular' }[k]))));
      const list = h('div', { class: 'gl-list' });
      const cmp = { dist: (a, b) => a[2] - b[2], rating: (a, b) => (b[1].rating || 0) - (a[1].rating || 0), reviews: (a, b) => (b[1].reviews || 0) - (a[1].reviews || 0) }[sortBy];
      for (const x of scope) {
        list.append(h('div', { class: 'gl-row hubrow', onclick: () => selectHub(x.hub.id) },
          h('div', { class: 'th' }, h('span', { class: 'gl-i' }, PURE.glyph(x.hub.cat || 'charg'))),
          h('div', { style: { minWidth: '0' } }, h('div', { class: 'nm' }, x.hub.name), h('div', { class: 'mt' }, (x.hub.addr || '').split(',')[0])),
          h('span', { class: 'num' }, x.list.length + ' places'), h('span', { class: 'num' }, x.d.toFixed(1) + ' mi')));
        for (const [fi, p, d] of x.list.slice().sort(cmp)) {
          list.append(h('div', { class: 'gl-row' + (S.ui.hover === p.id ? ' hov' : ''), 'data-id': p.id, onclick: () => window.open(placeUrl(p), '_blank'),
            onmouseenter: (e) => { S.ui.hover = p.id; MAP.draw(); card(p, e.currentTarget.getBoundingClientRect()); },
            onmouseleave: () => { S.ui.hover = null; MAP.draw(); cardHideSoon(); } },
            h('div', { class: 'th', style: p.photo ? { backgroundImage: 'url("' + sized(p.photo, 96, 96) + '")' } : null }),
            h('div', { style: { minWidth: '0' } },
              h('div', { class: 'nm' }, h('span', { class: 'gl-dotc', style: { background: FIND_COLORS[fi % FIND_COLORS.length], display: 'inline-block', marginRight: '6px' } }), p.name),
              h('div', { class: 'mt' }, p.cat, ' · ', hoursEl(p.hours), hoursRest(p.hours))),
            h('span', { class: 'num' }, p.rating ? [h('span', { style: { color: 'var(--ylw)' } }, '★ '), String(p.rating)] : '', p.reviews ? h('div', { class: 'gl-dim', style: { fontSize: '11px' } }, '(' + p.reviews.toLocaleString() + ')') : null),
            h('span', { class: 'num' }, d.toFixed(2) + ' mi')));
        }
      }
      list.addEventListener('scroll', () => { scrollMemo.list = list.scrollTop; });
      setTimeout(() => { list.scrollTop = scrollMemo.list || 0; });
      return [head, list];
    }
    function sheet() {
      const hubs = F.hubs(), sel = selectedHub(hubs), mode = S.cfg.sheet;
      const grab = h('div', { class: 'gl-grab', title: 'Drag or click: cards / list' }, h('i'));
      dragSheet(grab);
      const idx = sel ? hubs.indexOf(sel) : -1;
      const nav = (dir) => h('button', { class: 'gl-nav', title: dir < 0 ? 'Previous' : 'Next',
        onclick: () => { const n = hubs[(idx + dir + hubs.length) % hubs.length]; if (n) selectHub(n.hub.id); } }, icon(dir < 0 ? 'chevron_left' : 'chevron_right'));
      const tabsRow = h('div', { style: { display: 'flex', gap: '0', alignItems: 'stretch', padding: '0 0 0 0', flex: 'none' } });
      const tabs = hubTabs(hubs, sel);
      tabsRow.append(h('div', { style: { padding: '4px 0 8px 12px', display: 'flex' } }, nav(-1)), tabs, h('div', { style: { padding: '4px 12px 8px 0', display: 'flex' } }, nav(1)));
      tabs.style.flex = '1';
      const status = h('div', { class: 'gl-status' },
        h('span', { class: 'sp' }, S.ui.status || (sel ? (idx + 1) + ' of ' + hubs.length + ' · ' + sel.hub.name + ' · within ' + F.radius() + ' mi' : '')),
        h('button', { class: 'gl-sbtn', title: mode === 'list' ? 'Back to cards' : 'Everything as a list',
          onclick: () => setCfg({ sheet: mode === 'list' ? 'cards' : 'list' }) }, icon(mode === 'list' ? 'view_carousel' : 'view_list'), mode === 'list' ? 'Cards' : 'List'),
        h('button', { class: 'gl-sbtn', title: mode === 'min' ? 'Show cards' : 'Minimise',
          onclick: () => setCfg({ sheet: mode === 'min' ? 'cards' : 'min' }) }, icon(mode === 'min' ? 'expand_less' : 'expand_more')));
      const body = mode === 'list' ? listView(hubs, sel) : mode === 'cards' ? cardsFor(sel) : null;
      const el = h('div', { class: 'gl-sheet', style: { left: leftPx + 'px', right: '64px', height: sheetH() + 'px' } },
        grab, h('div', { class: 'gl-prog', style: { visibility: S.ui.running ? 'visible' : 'hidden' } }, h('i', { style: { width: Math.round(S.ui.progress * 100) + '%' } })),
        status, tabsRow, body);
      return el;
    }
    // drag the grab handle: up = more (min -> cards -> list), down = less; click cycles
    function dragSheet(grab) {
      let y0 = null, moved = false;
      grab.addEventListener('pointerdown', (e) => { y0 = e.clientY; moved = false; grab.setPointerCapture(e.pointerId); });
      grab.addEventListener('pointermove', (e) => { if (y0 != null && Math.abs(e.clientY - y0) > 6) moved = true; });
      grab.addEventListener('pointerup', (e) => {
        if (y0 == null) return;
        const dy = e.clientY - y0; y0 = null;
        const order = ['min', 'cards', 'list'], i = order.indexOf(S.cfg.sheet);
        const next = !moved ? order[(i + 1) % 3] : dy < 0 ? order[Math.min(2, i + 1)] : order[Math.max(0, i - 1)];
        setCfg({ sheet: next });
      });
    }

    // ---- hover card (clickable: stays while the pointer is on it)
    function card(p, rect) {
      if (!p) return;
      clearTimeout(cardTimer);
      if (cardEl) cardEl.remove();
      cardEl = h('div', { class: 'gl-card-pop', onmouseenter: () => clearTimeout(cardTimer), onmouseleave: () => cardHideSoon() },
        h('div', { class: 'ph', style: p.photo ? { backgroundImage: 'url("' + sized(p.photo, 600, 300) + '")' } : { display: 'none' } }),
        h('div', { class: 'cb' },
          h('div', { class: 'nm' }, p.name),
          h('div', { class: 'gl-dim' }, p.rating ? [h('b', { style: { color: 'var(--t1)' } }, String(p.rating)), ' ', starsEl(p.rating), ' (' + (p.reviews || 0).toLocaleString() + ')'] : 'No rating', p.price ? ' · ' + p.price : ''),
          h('div', { class: 'gl-dim' }, p.cat),
          p.hours ? h('div', null, hoursEl(p.hours), h('span', { class: 'gl-dim' }, hoursRest(p.hours))) : null,
          p.addr ? h('div', { class: 'gl-dim' }, p.addr) : null,
          h('div', { class: 'acts' },
            h('button', { class: 'gl-act', onclick: () => window.open(dirUrl(p), '_blank') }, icon('directions'), 'Directions'),
            h('button', { class: 'gl-act', onclick: () => window.open(placeUrl(p), '_blank') }, icon('open_in_new'), 'Open'))));
      root.append(cardEl);
      const w = 300, ch = cardEl.offsetHeight;
      let x = rect.right + 12; if (x + w > innerWidth - 8) x = rect.left - w - 12;
      let y = Math.min(Math.max(8, rect.top - 40), innerHeight - ch - 8);
      if (rect.top > sheetTop() - 4) y = Math.max(8, sheetTop() - ch - 8);   // rows in the sheet: card above it
      Object.assign(cardEl.style, { left: Math.max(8, x) + 'px', top: y + 'px' });
    }
    function cardHideSoon() { clearTimeout(cardTimer); cardTimer = setTimeout(() => { if (cardEl) { cardEl.remove(); cardEl = null; } }, 220); }

    function render() {
      const active = document.activeElement;
      const keepFocus = active && root.contains(active) && active.tagName === 'INPUT';
      if (keepFocus) return;   // don't rebuild under the cursor; the next change re-renders
      root.textContent = '';
      document.documentElement.classList.toggle('gl-active', !S.cfg.hidden);
      if (S.cfg.hidden) {
        // beside Google's Layers thumbnail (bottom-left), not on it
        root.append(h('button', { class: 'gl-pill', style: { left: leftPx + 110 + 'px', bottom: '24px' }, onclick: () => setCfg({ hidden: false }) },
          h('span', { class: 'gl-i', style: { color: 'var(--acc)' } }, 'layers'), 'Map layers', S.res ? h('span', { class: 'gl-dim', style: { fontWeight: '400' } }, ' \u00b7 ' + S.res.hubs.length + ' hubs') : null));
        return;
      }
      root.append(bar(), chips());
      if (S.res || S.ui.running) root.append(sheet());
      else if (S.ui.status) root.append(h('div', { class: 'gl-pill', style: { left: leftPx + 12 + 'px', cursor: 'default' } }, S.ui.status));
      if (cardEl) root.append(cardEl);
    }
    return { css, root, render, sheetTop, place, selectedHub, selectHub, card, cardHideSoon, closeMenu };
  })();

  // ======================================================================== BOOT
  const oldIcons = document.getElementById('gl-icons');   // a reload with a new icon list swaps the link
  if (!oldIcons || oldIcons.getAttribute('href') !== ICON_CSS) { if (oldIcons) oldIcons.remove(); document.head.append(h('link', { id: 'gl-icons', rel: 'stylesheet', href: ICON_CSS })); }
  document.head.append(UI.css);
  document.body.append(MAP.ov, UI.root);
  let lastHref = '';
  const tick = setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; MAP.ov.style.visibility = ''; MAP.draw(); if (!S.ui.running) UI.render(); }
  }, 200);
  // clock-based filters (open now / open by) re-apply each minute even if the map sits still
  const clock = setInterval(() => { if (S.res && S.cfg.openWithin >= 0) { UI.render(); MAP.draw(); } }, 60000);
  // hide dots while dragging the map; the URL change at the end of the pan redraws them
  const hide = (e) => { if (e.target === MAP.canvas()) { MAP.ov.style.visibility = 'hidden'; if (e.type === 'wheel') show(); } };
  const show = () => setTimeout(() => { MAP.ov.style.visibility = ''; MAP.draw(); }, 900);
  const onKey = (e) => {
    if (e.key === 'Escape') UI.closeMenu();
    // [ and ] step through hubs (arrow keys belong to the map)
    if ((e.key === '[' || e.key === ']') && S.res && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      const hubs = F.hubs(), sel = UI.selectedHub(hubs), i = hubs.indexOf(sel);
      const n = hubs[(i + (e.key === ']' ? 1 : -1) + hubs.length) % hubs.length];
      if (n) UI.selectHub(n.hub.id);
    }
  };
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, true);
  document.addEventListener('pointerup', show, true);
  document.addEventListener('keydown', onKey);
  const onResize = () => { UI.render(); MAP.draw(); };
  addEventListener('resize', onResize);
  UI.render(); MAP.draw();

  window.__gmLayers = {
    version: 2, run: ENGINE.run, searchAll: API.searchAll, cancel: ENGINE.cancel, view: MAP.view, PURE, S, clearCache: CACHE.clear,
    geocode: (q) => API.geocode(q, MAP.view() || { lat: 41.88, lng: -87.63 }),
    destroy() {
      ENGINE.cancel(''); clearInterval(tick); clearInterval(clock);
      document.removeEventListener('pointerdown', hide, true); document.removeEventListener('wheel', hide, true);
      document.removeEventListener('pointerup', show, true); document.removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize); UI.closeMenu();
      MAP.ov.remove(); UI.root.remove(); UI.css.remove(); document.documentElement.classList.remove('gl-active');
    },
  };
})();
