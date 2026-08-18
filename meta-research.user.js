// ==UserScript==
// @name         Meta Ad Library Research RADAR
// @namespace    meta.research.local
// @version      0.5.3.5
// @description  Mobile-safe Meta Ad Library collector + Opportunity Radar + collapse + CSV share
// @match        https://www.facebook.com/ads/library/*
// @match        https://*.facebook.com/ads/library/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/menteora/tamper-ads/main/meta-research.user.js
// @downloadURL  https://raw.githubusercontent.com/menteora/tamper-ads/main/meta-research.user.js
// ==/UserScript==

(function () {
  'use strict';

  var VERSION = 'v5.3.5 RADAR';
  var DB_KEY = 'meta_ad_research_v53_radar';
  var LEGACY_KEYS = [
    'meta_ad_research_v52_core',
    'meta_ad_research_v52_mobile',
    'meta_ad_research_v51_edge',
    'meta_ad_research_v51',
    'meta_ad_research_v50',
    'meta_ad_research_v42'
  ];
  var TOP_SCORE = 65;
  var db = {};
  var ui = {};
  var state = {
    running: false,
    timer: null,
    stopAt: 0,
    hooks: false,
    originalFetch: null,
    originalOpen: null,
    originalSend: null,
    fetchRequests: 0,
    xhrRequests: 0,
    graphqlRequests: 0,
    responses: 0,
    payloads: 0,
    parsed: 0,
    scrolls: 0,
    queue: [],
    queueBusy: false,
    scanBusy: false,
    sessionSeen: {},
    sessionNew: {},
    sessionKnown: {},
    lastError: '',
    activeFilter: 'TOP',
    groupCache: null,
    analysisOpen: false,
    analysisBusy: false,
    collapsed: false,
    uiTimer: null,
    lastUIRender: 0
  };

  function nowISO() { return new Date().toISOString(); }
  function today() { return nowISO().slice(0, 10); }
  function clean(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\s+/g, ' ').trim();
  }
  function firstValue(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] !== undefined && list[i] !== null && list[i] !== '') return list[i];
    }
    return '';
  }
  function uniqueAdd(arr, value) {
    if (value && arr.indexOf(value) === -1) arr.push(value);
    return arr;
  }
  function getParam(name) {
    try { return new URL(location.href).searchParams.get(name) || ''; }
    catch (e) { return ''; }
  }
  function make(tag, text) {
    var el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function button(text, handler) {
    var b = make('button', text);
    b.style.marginRight = '5px';
    b.style.marginTop = '5px';
    b.addEventListener('click', handler);
    return b;
  }
  function dbCount() { return Object.keys(db).length; }

  function loadDB() {
    var raw = null;
    try {
      raw = localStorage.getItem(DB_KEY);
      if (!raw) {
        for (var i = 0; i < LEGACY_KEYS.length; i++) {
          raw = localStorage.getItem(LEGACY_KEYS[i]);
          if (raw) break;
        }
      }
      db = raw ? JSON.parse(raw) : {};
      if (!db || typeof db !== 'object' || Array.isArray(db)) db = {};
    } catch (e) {
      db = {};
      state.lastError = 'LOAD DB: ' + String(e);
    }
  }

  function saveDB() {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
    catch (e) { state.lastError = 'SAVE DB: ' + String(e); }
    updateUI();
  }

  function upsert(id, patch) {
    if (!id) return;
    var existed = !!db[id];
    var old = db[id] || {};
    var row = {};
    Object.keys(old).forEach(function (k) { row[k] = old[k]; });
    Object.keys(patch || {}).forEach(function (k) {
      if (patch[k] !== '' && patch[k] !== null && patch[k] !== undefined) row[k] = patch[k];
    });
    row.library_id = String(id);
    row.first_seen = old.first_seen || patch.first_seen || nowISO();
    row.last_seen = patch.last_seen || nowISO();
    row.countries_seen = Array.isArray(old.countries_seen) ? old.countries_seen.slice() : [];
    row.keywords_seen = Array.isArray(old.keywords_seen) ? old.keywords_seen.slice() : [];
    row.observed_dates = Array.isArray(old.observed_dates) ? old.observed_dates.slice() : [];
    uniqueAdd(row.countries_seen, old.country);
    uniqueAdd(row.countries_seen, patch.country);
    uniqueAdd(row.keywords_seen, old.keyword);
    uniqueAdd(row.keywords_seen, patch.keyword);
    uniqueAdd(row.observed_dates, today());
    db[id] = row;
    state.groupCache = null;
    if (!state.sessionSeen[id]) {
      state.sessionSeen[id] = true;
      if (existed) state.sessionKnown[id] = true;
      else state.sessionNew[id] = true;
    }
  }

  function normalizeDate(value) {
    if (!value) return '';
    try {
      var n, d;
      if (typeof value === 'number' || /^\d+$/.test(String(value))) {
        n = Number(value);
        if (n < 100000000000) n *= 1000;
        d = new Date(n);
      } else {
        d = new Date(value);
      }
      if (isNaN(d.getTime())) return '';
      return d.toISOString().slice(0, 10);
    } catch (e) { return ''; }
  }

  function daysSince(dateString) {
    if (!dateString) return '';
    var d = new Date(dateString + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  }

  function getAdId(obj) {
    if (!obj || typeof obj !== 'object') return '';
    var id = firstValue([
      obj.ad_archive_id,
      obj.adArchiveID,
      obj.adArchiveId,
      obj.ad_library_id,
      obj.adLibraryId
    ]);
    if (id && /^\d{6,}$/.test(String(id))) return String(id);
    return '';
  }

  function extractBody(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return '';
    var body = snapshot.body;
    if (typeof body === 'string') return clean(body).slice(0, 3000);
    if (body && typeof body === 'object') {
      if (body.text) return clean(body.text).slice(0, 3000);
      if (body.markup && body.markup.__html) return clean(body.markup.__html).slice(0, 3000);
      if (body.__html) return clean(body.__html).slice(0, 3000);
    }
    if (snapshot.body_text) return clean(snapshot.body_text).slice(0, 3000);
    return '';
  }

  function findMedia(obj, depth) {
    if (!obj || depth > 6) return '';
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        var ar = findMedia(obj[i], depth + 1);
        if (ar) return ar;
      }
      return '';
    }
    if (typeof obj !== 'object') return '';
    var keys = [
      'video_preview_image_url', 'videoPreviewImageUrl',
      'resized_image_url', 'resizedImageUrl',
      'image_url', 'imageUrl', 'thumbnail_url', 'thumbnailUrl'
    ];
    for (var j = 0; j < keys.length; j++) {
      var value = obj[keys[j]];
      if (typeof value === 'string' && /^https?:\/\//.test(value)) return value;
    }
    var objKeys = Object.keys(obj);
    for (var k = 0; k < objKeys.length; k++) {
      try {
        var r = findMedia(obj[objKeys[k]], depth + 1);
        if (r) return r;
      } catch (e) {}
    }
    return '';
  }

  function saveObject(obj, source) {
    if (!obj || typeof obj !== 'object') return;
    var id = getAdId(obj);
    if (!id) return;
    var old = db[id] || {};
    var snapshot = obj.snapshot || obj.ad_snapshot || {};
    var page = obj.page || {};
    var startDate = normalizeDate(firstValue([
      obj.start_date, obj.startDate,
      obj.ad_delivery_start_time, obj.adDeliveryStartTime
    ]));
    var landing = clean(firstValue([
      snapshot.link_url, snapshot.linkUrl,
      snapshot.website_url, snapshot.websiteUrl,
      obj.link_url, obj.linkUrl, old.landing_url
    ]));
    upsert(id, {
      page_id: clean(firstValue([obj.page_id, obj.pageID, obj.pageId, page.id, old.page_id])),
      page_name: clean(firstValue([obj.page_name, obj.pageName, page.name, old.page_name])),
      is_active: firstValue([obj.is_active, obj.isActive, old.is_active]),
      start_date: startDate || old.start_date || '',
      days_active: startDate ? daysSince(startDate) : (old.days_active || ''),
      body: extractBody(snapshot) || old.body || '',
      title: clean(firstValue([snapshot.title, snapshot.link_description, snapshot.linkDescription, old.title])).slice(0, 1000),
      caption: clean(firstValue([snapshot.caption, old.caption])).slice(0, 1000),
      cta: clean(firstValue([snapshot.cta_text, snapshot.ctaText, old.cta])),
      landing_url: landing,
      media_url: findMedia(snapshot, 0) || old.media_url || '',
      country: getParam('country'),
      keyword: getParam('q'),
      source: source,
      last_seen: nowISO(),
      ad_library_url: 'https://www.facebook.com/ads/library/?id=' + id
    });
  }

  function rawIds(text, source) {
    var re = /\"(?:ad_archive_id|adArchiveID|adArchiveId)\"\s*:\s*\"?(\d{6,})\"?/g;
    var m, count = 0;
    while ((m = re.exec(text)) !== null) {
      upsert(m[1], {
        country: getParam('country'),
        keyword: getParam('q'),
        source: source + '_RAW',
        last_seen: nowISO(),
        ad_library_url: 'https://www.facebook.com/ads/library/?id=' + m[1]
      });
      count++;
      if (count > 5000) break;
    }
  }

  function walkAsync(root, source, done) {
    var stack = [root];
    var total = 0;
    function step() {
      var budget = 250;
      while (stack.length && budget > 0) {
        var value = stack.pop();
        budget--;
        total++;
        if (total > 100000) {
          state.lastError = 'WALK LIMIT 100000';
          stack.length = 0;
          break;
        }
        if (!value) continue;
        if (Array.isArray(value)) {
          for (var i = value.length - 1; i >= 0; i--) stack.push(value[i]);
          continue;
        }
        if (typeof value !== 'object') continue;
        saveObject(value, source);
        var keys = Object.keys(value);
        for (var j = keys.length - 1; j >= 0; j--) {
          try { stack.push(value[keys[j]]); } catch (e) {}
        }
      }
      updateUI();
      if (stack.length) setTimeout(step, 0);
      else done();
    }
    step();
  }

  function enqueue(text, source) {
    if (!text || typeof text !== 'string') return;
    if (!/ad_archive_id|adArchiveID|adArchiveId|collated_results|ad_library_main/i.test(text)) return;
    state.queue.push({ text: text, source: source });
    state.payloads++;
    rawIds(text, source);
    pumpQueue();
    updateUI();
  }

  function pumpQueue() {
    if (state.queueBusy) return;
    var item = state.queue.shift();
    if (!item) { updateUI(); return; }
    state.queueBusy = true;
    var lines = item.text.split('\n');
    var idx = 0;
    function nextLine() {
      while (idx < lines.length) {
        var line = clean(lines[idx++]);
        if (!line) continue;
        if (line.indexOf('for (;;);') === 0) line = clean(line.slice(9));
        if (!line) continue;
        try {
          var data = JSON.parse(line);
          state.parsed++;
          walkAsync(data, item.source, nextLine);
          return;
        } catch (e) {}
      }
      state.queueBusy = false;
      saveDB();
      setTimeout(pumpQueue, 0);
    }
    nextLine();
  }

  function isGraphQL(url) { return /graphql/i.test(String(url || '')); }

  function installHooks() {
    if (state.hooks) return;
    try {
      state.originalFetch = window.fetch;
      if (typeof state.originalFetch === 'function') {
        window.fetch = function () {
          var args = arguments;
          var url = '';
          try {
            url = typeof args[0] === 'string' ? args[0] : ((args[0] && args[0].url) || '');
          } catch (e) {}
          state.fetchRequests++;
          if (isGraphQL(url)) state.graphqlRequests++;
          var p = state.originalFetch.apply(this, args);
          if (isGraphQL(url)) {
            p.then(function (response) {
              try {
                response.clone().text().then(function (text) {
                  state.responses++;
                  enqueue(text, 'NETWORK');
                }).catch(function () {});
              } catch (e) {}
            }).catch(function () {});
          }
          return p;
        };
      }

      state.originalOpen = XMLHttpRequest.prototype.open;
      state.originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__mrURL = String(url || ''); } catch (e) {}
        return state.originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        var url = xhr.__mrURL || '';
        state.xhrRequests++;
        if (isGraphQL(url)) {
          state.graphqlRequests++;
          xhr.addEventListener('load', function () {
            var text = '';
            try {
              if (xhr.responseType === '' || xhr.responseType === 'text') text = xhr.responseText;
              else if (xhr.responseType === 'json') text = JSON.stringify(xhr.response);
              if (text) {
                state.responses++;
                enqueue(text, 'NETWORK');
              }
            } catch (e) { state.lastError = 'XHR LOAD: ' + String(e); }
          }, { once: true });
        }
        return state.originalSend.apply(this, arguments);
      };
      state.hooks = true;
    } catch (e) {
      state.lastError = 'HOOKS: ' + String(e);
    }
    updateUI();
  }

  function restoreHooks() {
    try {
      if (state.originalFetch) window.fetch = state.originalFetch;
      if (state.originalOpen) XMLHttpRequest.prototype.open = state.originalOpen;
      if (state.originalSend) XMLHttpRequest.prototype.send = state.originalSend;
      state.hooks = false;
    } catch (e) { state.lastError = 'RESTORE: ' + String(e); }
    updateUI();
  }

  function scanScripts() {
    if (state.scanBusy) return;
    state.scanBusy = true;
    var scripts;
    try { scripts = document.querySelectorAll('script'); }
    catch (e) {
      state.scanBusy = false;
      state.lastError = 'SCAN LIST: ' + String(e);
      updateUI();
      return;
    }
    var i = 0;
    function step() {
      if (i >= scripts.length) {
        state.scanBusy = false;
        updateUI();
        return;
      }
      try {
        var text = scripts[i++].textContent || '';
        if (/ad_archive_id|adArchiveID|adArchiveId|collated_results|ad_library_main/i.test(text)) {
          enqueue(text, 'SCRIPT');
        }
      } catch (e) {}
      setTimeout(step, 25);
    }
    step();
  }

  function start() {
    if (state.running) return;
    var seconds = parseInt(ui.seconds.value || '30', 10);
    if (!isFinite(seconds) || seconds < 1) seconds = 30;
    state.sessionSeen = {};
    state.sessionNew = {};
    state.sessionKnown = {};
    state.running = true;
    state.stopAt = Date.now() + seconds * 1000;
    state.scrolls = 0;
    installHooks();
    setTimeout(scanScripts, 100);
    state.timer = setInterval(function () {
      if (Date.now() >= state.stopAt) { stop(); return; }
      window.scrollBy(0, Math.max(450, Math.floor(window.innerHeight * 0.8)));
      state.scrolls++;
      updateUI();
    }, 1200);
    updateUI();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.running = false;
    saveDB();
    setTimeout(restoreHooks, 1500);
    updateUI();
  }

  function csvEscape(value) {
    return '"' + String(value === undefined || value === null ? '' : value).replace(/"/g, '""') + '"';
  }

  function buildCSVData() {
    var fields = [
      'library_id','page_id','page_name','is_active','start_date','days_active',
      'country','keyword','countries_seen','keywords_seen','observed_dates','body',
      'title','caption','cta','landing_url','media_url','source','first_seen','last_seen','ad_library_url'
    ];
    var rows = Object.keys(db).map(function (id) { return db[id]; });
    if (!rows.length) return null;
    var csv = fields.join(',') + '\n' + rows.map(function (row) {
      return fields.map(function (field) {
        var value = row[field];
        if (Array.isArray(value)) value = value.join(' | ');
        return csvEscape(value);
      }).join(',');
    }).join('\n');
    return {
      csv: '\ufeff' + csv,
      filename: 'meta-ads-' + (getParam('country') || 'ALL') + '-' + today() + '.csv'
    };
  }

  function downloadCSVData(data) {
    var blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportCSV() {
    var data = buildCSVData();
    if (!data) {
      alert('Nessuna inserzione raccolta.');
      return;
    }
    downloadCSVData(data);
  }

  function shareCSV() {
    var data = buildCSVData();
    if (!data) {
      alert('Nessuna inserzione raccolta.');
      return;
    }

    if (typeof File !== 'function' || typeof navigator.share !== 'function') {
      downloadCSVData(data);
      return;
    }

    var file = new File([data.csv], data.filename, { type: 'text/csv;charset=utf-8' });
    var shareData = {
      title: 'Meta Research CSV',
      text: dbCount() + ' ads raccolte - ' + VERSION,
      files: [file]
    };

    if (typeof navigator.canShare === 'function') {
      try {
        if (!navigator.canShare({ files: [file] })) {
          downloadCSVData(data);
          return;
        }
      } catch (e) {
        downloadCSVData(data);
        return;
      }
    }

    try {
      navigator.share(shareData).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        state.lastError = 'SHARE: ' + String(err && (err.message || err) || 'errore');
        downloadCSVData(data);
        updateUI();
      });
    } catch (e) {
      state.lastError = 'SHARE: ' + String(e);
      downloadCSVData(data);
      updateUI();
    }
  }

  var PROBLEM_PATTERNS = [
    /\bstruggling\b/i,/\btired of\b/i,/\bdid you know\b/i,/\bproblem\b/i,/\bpain\b/i,
    /\bannoying\b/i,/\bhard to\b/i,/\bdifficult\b/i,/\bcan't\b/i,/\bcannot\b/i,
    /\bnever knew\b/i,/\bstop wasting\b/i,/\bfinally\b/i,/\bsolution\b/i,
    /\bproblema\b/i,/\bstanco di\b/i,/\bsapevi che\b/i,/\bnon sapevi\b/i,/\bdifficile\b/i,
    /\bfastidioso\b/i,/\bnon riesci\b/i,/\bfinalmente\b/i,/\bsoluzione\b/i,
    /\bcansado de\b/i,/\bsab[ií]as que\b/i,/\bno sab[ií]as\b/i,/\bdif[ií]cil\b/i,
    /\bmolesto\b/i,/\bsoluci[oó]n\b/i,/\bprobl[eè]me\b/i,/\bfatigu[eé] de\b/i,/\bsaviez-vous\b/i
  ];

  function flattenSeen(ad, listField, singleField) {
    var out = [];
    if (!ad) return out;
    var arr = ad[listField];
    if (Array.isArray(arr)) {
      for (var i = 0; i < arr.length; i++) uniqueAdd(out, arr[i]);
    }
    uniqueAdd(out, ad[singleField]);
    return out;
  }

  function validHttpUrl(value) {
    if (!value) return '';
    try {
      var u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.href;
    } catch (e) { return ''; }
  }

  function landingIdentity(value) {
    value = validHttpUrl(value);
    if (!value) return '';
    try {
      var u = new URL(value);
      var host = String(u.hostname || '').toLowerCase().replace(/^www\./, '');
      var parts = String(u.pathname || '').split('/').filter(function (x) { return !!x; }).slice(0, 2);
      return host + (parts.length ? '/' + parts.join('/') : '');
    } catch (e) { return ''; }
  }

  function landingHost(value) {
    value = validHttpUrl(value);
    if (!value) return '';
    try { return String(new URL(value).hostname || '').toLowerCase().replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  function problemHits(ad) {
    var text = clean((ad.body || '') + ' ' + (ad.title || '') + ' ' + (ad.caption || ''));
    var hits = 0;
    for (var i = 0; i < PROBLEM_PATTERNS.length; i++) if (PROBLEM_PATTERNS[i].test(text)) hits++;
    return hits;
  }

  function longevityScore(days) {
    if (days >= 61) return 35;
    if (days >= 31) return 32;
    if (days >= 15) return 27;
    if (days >= 7) return 18;
    if (days >= 3) return 8;
    if (days >= 1) return 3;
    return 0;
  }
  function creativeScore(count) {
    if (count >= 10) return 20;
    if (count >= 7) return 17;
    if (count >= 5) return 14;
    if (count >= 3) return 10;
    if (count >= 2) return 5;
    return 0;
  }
  function observationScore(count) {
    if (count >= 4) return 15;
    if (count === 3) return 10;
    if (count === 2) return 6;
    return 0;
  }
  function problemScore(count) {
    if (count >= 3) return 15;
    if (count === 2) return 13;
    if (count === 1) return 9;
    return 0;
  }
  function landingScore(total, withLanding, distinctLanding) {
    if (!total || !withLanding) return 0;
    var coverage = withLanding / total;
    if (coverage >= 0.8 && distinctLanding === 1) return 10;
    if (coverage >= 0.5 && distinctLanding <= 2) return 7;
    return 3;
  }
  function marketScore(count) {
    if (count >= 3) return 5;
    if (count === 2) return 3;
    return 0;
  }

  function groupKeyForAd(ad) {
    var landing = landingIdentity(ad.landing_url);
    if (landing) return 'landing:' + landing;
    if (ad.page_id) return 'page:' + ad.page_id;
    if (ad.page_name) return 'name:' + clean(ad.page_name).toLowerCase();
    return 'ad:' + ad.library_id;
  }

  function analyseGroup(group) {
    var ads = group.ads;
    var pageNames = [], landingUrls = [], landingIds = [], landingHosts = [], countries = [], observed = [];
    var oldestDays = 0, problemAds = 0, media = '', landing = '', sample = '', adUrl = '';
    for (var i = 0; i < ads.length; i++) {
      var ad = ads[i];
      uniqueAdd(pageNames, ad.page_name);
      uniqueAdd(landingUrls, ad.landing_url);
      uniqueAdd(landingIds, landingIdentity(ad.landing_url));
      uniqueAdd(landingHosts, landingHost(ad.landing_url));
      var seen = flattenSeen(ad, 'countries_seen', 'country');
      for (var j = 0; j < seen.length; j++) uniqueAdd(countries, seen[j]);
      seen = Array.isArray(ad.observed_dates) ? ad.observed_dates : [];
      for (var k = 0; k < seen.length; k++) uniqueAdd(observed, seen[k]);
      var n = Number(ad.days_active);
      if (isFinite(n) && n > oldestDays) oldestDays = n;
      if (problemHits(ad) > 0) problemAds++;
      if (!media && validHttpUrl(ad.media_url)) media = ad.media_url;
      if (!landing && validHttpUrl(ad.landing_url)) landing = ad.landing_url;
      if (!sample && clean(ad.body || ad.title)) sample = clean(ad.body || ad.title).slice(0, 260);
      if (!adUrl && validHttpUrl(ad.ad_library_url)) adUrl = ad.ad_library_url;
    }
    var parts = {
      longevity: longevityScore(oldestDays),
      creatives: creativeScore(ads.length),
      observation: observationScore(observed.length),
      problem: problemScore(problemAds),
      landing: landingScore(ads.length, landingUrls.length, landingIds.length),
      markets: marketScore(countries.length)
    };
    var score = parts.longevity + parts.creatives + parts.observation + parts.problem + parts.landing + parts.markets;
    var label = score >= 80 ? 'FORTE' : (score >= TOP_SCORE ? 'INTERESSANTE' : (score < 35 ? 'BASSO' : 'WATCH'));
    return {
      key: group.key,
      ads: ads,
      displayName: pageNames[0] || landingHosts[0] || ('Ad ' + (ads[0] ? ads[0].library_id : '')),
      score: score,
      label: label,
      scoreParts: parts,
      oldestDays: oldestDays,
      problemAds: problemAds,
      countries: countries,
      observedDates: observed,
      landingUrls: landingUrls,
      mediaUrl: media,
      landingUrl: landing,
      adLibraryUrl: adUrl,
      sampleText: sample
    };
  }

  function buildGroups() {
    if (state.groupCache) return state.groupCache;
    var map = {};
    Object.keys(db).forEach(function (id) {
      var ad = db[id];
      var key = groupKeyForAd(ad);
      if (!map[key]) map[key] = { key: key, ads: [] };
      map[key].ads.push(ad);
    });
    var groups = Object.keys(map).map(function (k) { return analyseGroup(map[k]); });
    groups.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return b.ads.length - a.ads.length;
    });
    state.groupCache = groups;
    return groups;
  }

  function filterGroups(groups) {
    return groups.filter(function (g) {
      if (state.activeFilter === 'ALL') return true;
      if (state.activeFilter === 'TOP') return g.score >= TOP_SCORE;
      if (state.activeFilter === '15D') return g.oldestDays >= 15;
      if (state.activeFilter === '3ADS') return g.ads.length >= 3;
      if (state.activeFilter === 'PROBLEM') return g.problemAds > 0;
      return true;
    });
  }

  function smallBadge(text) {
    var b = make('span', text);
    b.style.cssText = 'display:inline-block;margin:2px 4px 2px 0;padding:3px 6px;border:1px solid #555;border-radius:999px;font-size:9px;color:#ddd;';
    return b;
  }

  function openUrlButton(label, url) {
    url = validHttpUrl(url);
    if (!url) return null;
    var b = button(label, function () { window.open(url, '_blank'); });
    b.style.fontSize = '11px';
    return b;
  }

  function renderFilterButtons() {
    if (!ui.analysisFilters) return;
    var defs = [['TOP','TOP'],['15D','15+ GG'],['3ADS','3+ ADS'],['PROBLEM','PROBLEMA'],['ALL','TUTTI']];
    ui.analysisFilters.textContent = '';
    defs.forEach(function (def) {
      var b = button(def[1], function () {
        state.activeFilter = def[0];
        renderAnalysisCards();
      });
      if (state.activeFilter === def[0]) {
        b.style.fontWeight = 'bold';
        b.style.border = '2px solid #f2c94c';
      }
      ui.analysisFilters.appendChild(b);
    });
  }

  function renderAnalysisCards() {
    if (!ui.analysisList) return;
    state.analysisBusy = true;
    ui.analysisList.textContent = 'Calcolo gruppi...';
    setTimeout(function () {
      try {
        var groups = buildGroups();
        var filtered = filterGroups(groups);
        var topCount = groups.filter(function (x) { return x.score >= TOP_SCORE; }).length;
        ui.analysisSummary.textContent = dbCount() + ' ADS | ' + groups.length + ' GRUPPI | ' + topCount + ' TOP';
        renderFilterButtons();
        ui.analysisList.textContent = '';
        if (!filtered.length) {
          ui.analysisList.appendChild(make('div', 'Nessun risultato con questo filtro.'));
          state.analysisBusy = false;
          return;
        }
        filtered.forEach(function (g) {
          var card = make('div');
          card.style.cssText = 'margin-bottom:10px;padding:10px;border:1px solid #444;border-radius:9px;background:#181818;';
          var head = make('div');
          head.style.cssText = 'display:flex;justify-content:space-between;gap:8px;align-items:flex-start;';
          var title = make('strong', g.displayName);
          title.style.cssText = 'font-size:13px;overflow-wrap:anywhere;';
          var score = make('div', String(g.score));
          score.style.cssText = 'font-size:23px;font-weight:bold;min-width:36px;text-align:right;';
          head.appendChild(title);
          head.appendChild(score);
          card.appendChild(head);
          var body = make('div');
          body.style.cssText = 'display:flex;gap:9px;margin-top:7px;';
          if (g.mediaUrl) {
            var image = make('img');
            image.src = g.mediaUrl;
            image.loading = 'lazy';
            image.style.cssText = 'width:88px;height:88px;min-width:88px;object-fit:cover;border-radius:7px;background:#292929;';
            body.appendChild(image);
          }
          var meta = make('div');
          meta.style.cssText = 'flex:1;min-width:0;';
          meta.appendChild(smallBadge(g.label));
          meta.appendChild(smallBadge(g.ads.length + ' ADS'));
          meta.appendChild(smallBadge(g.oldestDays + ' GG'));
          meta.appendChild(smallBadge('PROB ' + g.problemAds));
          meta.appendChild(smallBadge(g.countries.length + ' MERCATI'));
          var copy = make('div', g.sampleText || 'Nessun copy estratto');
          copy.style.cssText = 'margin-top:6px;font-size:11px;line-height:1.35;';
          meta.appendChild(copy);
          var p = g.scoreParts;
          var breakdown = make('div', 'LONG ' + p.longevity + '/35 | ADS ' + p.creatives + '/20 | PROB ' + p.problem + '/15 | OBS ' + p.observation + '/15 | LAND ' + p.landing + '/10 | MKT ' + p.markets + '/5');
          breakdown.style.cssText = 'margin-top:6px;font-size:8px;font-family:monospace;color:#aaa;';
          meta.appendChild(breakdown);
          var actions = make('div');
          actions.style.marginTop = '5px';
          var openSite = openUrlButton('APRI SITO', g.landingUrl);
          if (openSite) actions.appendChild(openSite);
          var openAd = openUrlButton('VEDI AD', g.adLibraryUrl);
          if (openAd) actions.appendChild(openAd);
          meta.appendChild(actions);
          body.appendChild(meta);
          card.appendChild(body);
          ui.analysisList.appendChild(card);
        });
      } catch (e) {
        state.lastError = 'ANALISI: ' + String(e);
        ui.analysisList.textContent = 'Errore analisi: ' + String(e);
      }
      state.analysisBusy = false;
    }, 20);
  }

  function showAnalysis() {
    if (!ui.analysis) return;
    state.analysisOpen = true;
    ui.analysis.style.display = 'block';
    renderAnalysisCards();
  }

  function closeAnalysis() {
    state.analysisOpen = false;
    if (ui.analysis) ui.analysis.style.display = 'none';
  }

  function diagText() {
    return [
      'META RESEARCH ' + VERSION,
      '========================',
      'HOST: ' + location.hostname,
      'READY: ' + document.readyState,
      'UI: ' + !!document.getElementById('mr-core'),
      'COLLAPSED: ' + state.collapsed,
      'DB ADS: ' + dbCount(),
      'ANALYSIS OPEN: ' + state.analysisOpen,
      'ANALYSIS BUSY: ' + state.analysisBusy,
      'GROUP CACHE: ' + (state.groupCache ? state.groupCache.length : 'NON CALCOLATA'),
      'SESSION NEW: ' + Object.keys(state.sessionNew).length,
      'SESSION KNOWN: ' + Object.keys(state.sessionKnown).length,
      'RUNNING: ' + state.running,
      'HOOKS: ' + state.hooks,
      'FETCH REQ: ' + state.fetchRequests,
      'XHR REQ: ' + state.xhrRequests,
      'GRAPHQL: ' + state.graphqlRequests,
      'RESPONSES: ' + state.responses,
      'PAYLOADS: ' + state.payloads,
      'PARSED JSON: ' + state.parsed,
      'QUEUE: ' + state.queue.length,
      'QUEUE BUSY: ' + state.queueBusy,
      'SCAN BUSY: ' + state.scanBusy,
      'SCROLLS: ' + state.scrolls,
      'LAST ERROR: ' + (state.lastError || 'NESSUNO'),
      'BROWSER: ' + navigator.userAgent
    ].join('\n');
  }

  function showDiag() {
    ui.diagText.value = diagText();
    ui.diag.style.display = 'block';
  }

  function renderUI() {
    state.lastUIRender = Date.now();
    if (!ui.status) return;
    ui.count.textContent = dbCount() + ' ADS';
    ui.session.textContent = 'SESSIONE ' + Object.keys(state.sessionNew).length + ' NUOVE | ' + Object.keys(state.sessionKnown).length + ' NOTE';
    if (state.running) {
      var remain = Math.max(0, Math.ceil((state.stopAt - Date.now()) / 1000));
      ui.status.textContent = remain + 's | GQL ' + state.graphqlRequests + ' | CODA ' + state.queue.length;
    } else if (state.queueBusy || state.scanBusy) {
      ui.status.textContent = 'PARSING | ADS ' + dbCount() + ' | CODA ' + state.queue.length;
    } else {
      ui.status.textContent = 'PRONTO | HOOK ' + (state.hooks ? 'ON' : 'OFF');
    }
  }

  function updateUI() {
    var elapsed = Date.now() - state.lastUIRender;
    if (elapsed >= 250) {
      if (state.uiTimer) clearTimeout(state.uiTimer);
      state.uiTimer = null;
      renderUI();
      return;
    }
    if (state.uiTimer) return;
    state.uiTimer = setTimeout(function () {
      state.uiTimer = null;
      renderUI();
    }, Math.max(20, 250 - elapsed));
  }

  function installSafeCollapse(box) {
    if (!box || document.getElementById('mr-safe-collapse')) return;
    var btn = make('button', '-');
    btn.id = 'mr-safe-collapse';
    btn.title = 'Comprimi';
    btn.style.cssText = 'position:absolute!important;top:6px!important;right:6px!important;z-index:2147483647!important;width:30px!important;height:28px!important;padding:0!important;margin:0!important;font-size:18px!important;line-height:24px!important;';
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      state.collapsed = !state.collapsed;
      if (state.collapsed) {
        box.style.setProperty('height', '43px', 'important');
        box.style.setProperty('overflow', 'hidden', 'important');
        btn.textContent = '+';
        btn.title = 'Espandi';
      } else {
        box.style.removeProperty('height');
        box.style.removeProperty('overflow');
        btn.textContent = '-';
        btn.title = 'Comprimi';
      }
    });
    box.appendChild(btn);
  }

  function createUI() {
    if (!document.body) { setTimeout(createUI, 200); return; }
    if (document.getElementById('mr-core')) return;

    var box = make('div');
    box.id = 'mr-core';
    box.style.cssText = 'position:fixed!important;right:8px!important;bottom:8px!important;z-index:2147483647!important;width:min(380px,calc(100vw - 16px))!important;box-sizing:border-box!important;padding:12px!important;background:#111!important;color:#fff!important;border:3px solid #f2c94c!important;border-radius:10px!important;font-family:Arial,sans-serif!important;font-size:12px!important;box-shadow:0 5px 25px rgba(0,0,0,.55)!important;';
    var title = make('div', 'Meta Research ' + VERSION);
    title.style.fontWeight = 'bold';
    title.style.fontSize = '15px';
    title.style.marginBottom = '5px';
    title.style.paddingRight = '38px';
    box.appendChild(title);

    ui.count = make('div', '0 ADS');
    ui.count.style.fontFamily = 'monospace';
    box.appendChild(ui.count);

    ui.session = make('div', 'SESSIONE 0 NUOVE | 0 NOTE');
    ui.session.style.fontFamily = 'monospace';
    ui.session.style.fontSize = '10px';
    ui.session.style.marginTop = '2px';
    box.appendChild(ui.session);

    ui.status = make('div', 'PRONTO | HOOK OFF');
    ui.status.style.fontFamily = 'monospace';
    ui.status.style.marginTop = '5px';
    ui.status.style.marginBottom = '7px';
    box.appendChild(ui.status);

    var controls = make('div');
    controls.style.marginBottom = '4px';
    controls.appendChild(make('span', 'Sec. '));
    ui.seconds = make('input');
    ui.seconds.type = 'number';
    ui.seconds.min = '1';
    ui.seconds.value = '30';
    ui.seconds.style.width = '55px';
    ui.seconds.style.marginRight = '5px';
    controls.appendChild(ui.seconds);
    controls.appendChild(button('AVVIA', start));
    controls.appendChild(button('STOP', stop));
    box.appendChild(controls);

    var row = make('div');
    row.appendChild(button('ANALISI', showAnalysis));
    row.appendChild(button('SCAN', scanScripts));
    row.appendChild(button('DIAGNOSI', showDiag));
    row.appendChild(button('CSV', exportCSV));
    row.appendChild(button('CONDIVIDI', shareCSV));
    row.appendChild(button('RESET', function () {
      if (!confirm('Cancellare il database Meta Research?')) return;
      db = {};
      state.groupCache = null;
      try { localStorage.removeItem(DB_KEY); } catch (e) {}
      updateUI();
    }));
    box.appendChild(row);
    document.body.appendChild(box);
    installSafeCollapse(box);

    ui.analysis = make('div');
    ui.analysis.style.cssText = 'display:none;position:fixed;left:6px;right:6px;top:6px;bottom:6px;z-index:2147483647;background:#111;color:#fff;padding:10px;box-sizing:border-box;border:2px solid #f2c94c;border-radius:8px;font-family:Arial,sans-serif;';
    var analysisHead = make('div');
    analysisHead.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;';
    var analysisTitleWrap = make('div');
    analysisTitleWrap.appendChild(make('strong', 'Opportunity Radar ' + VERSION));
    ui.analysisSummary = make('div', 'Analisi non calcolata');
    ui.analysisSummary.style.cssText = 'font-size:10px;color:#aaa;margin-top:2px;';
    analysisTitleWrap.appendChild(ui.analysisSummary);
    analysisHead.appendChild(analysisTitleWrap);
    analysisHead.appendChild(button('CHIUDI', closeAnalysis));
    ui.analysis.appendChild(analysisHead);
    ui.analysisFilters = make('div');
    ui.analysisFilters.style.cssText = 'margin-bottom:7px;';
    ui.analysis.appendChild(ui.analysisFilters);
    var analysisNote = make('div', 'Score = priorita di ispezione, non probabilita di vendita.');
    analysisNote.style.cssText = 'font-size:9px;color:#aaa;margin-bottom:6px;';
    ui.analysis.appendChild(analysisNote);
    ui.analysisList = make('div');
    ui.analysisList.style.cssText = 'position:absolute;left:10px;right:10px;top:100px;bottom:10px;overflow:auto;padding-right:2px;';
    ui.analysis.appendChild(ui.analysisList);
    document.body.appendChild(ui.analysis);

    ui.diag = make('div');
    ui.diag.style.cssText = 'display:none;position:fixed;left:6px;right:6px;top:6px;bottom:6px;z-index:2147483647;background:#111;padding:10px;box-sizing:border-box;border:2px solid #f2c94c;border-radius:8px;';
    ui.diagText = make('textarea');
    ui.diagText.readOnly = true;
    ui.diagText.style.cssText = 'width:100%;height:calc(100% - 55px);box-sizing:border-box;font-family:monospace;font-size:11px;';
    ui.diag.appendChild(ui.diagText);
    ui.diag.appendChild(button('COPIA', function () {
      var text = diagText();
      ui.diagText.value = text;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
    }));
    ui.diag.appendChild(button('CHIUDI', function () { ui.diag.style.display = 'none'; }));
    document.body.appendChild(ui.diag);

    updateUI();
  }

  window.addEventListener('error', function (event) {
    state.lastError = 'JS: ' + (event.message || 'errore');
    updateUI();
  });
  window.addEventListener('unhandledrejection', function (event) {
    state.lastError = 'PROMISE: ' + String(event.reason || 'errore');
    updateUI();
  });

  loadDB();
  createUI();
  setTimeout(createUI, 1000);
  setTimeout(createUI, 3000);
})();
