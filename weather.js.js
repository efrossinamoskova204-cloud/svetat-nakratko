// Weather widget for "НОВИНИТЕ. И ТОЧКА."
// Loads current conditions + 3-day forecast directly in the browser from
// Open-Meteo (free, no API key, CORS-enabled). Fully independent from the
// news pipeline: if this script or the weather API fails, news keep working.
(function () {
  'use strict';

  // Preset Bulgarian cities with coordinates verified against the official
  // Open-Meteo geocoding service (country = Bulgaria).
  var CITIES = {
    'Велико Търново': [43.0812, 25.6171],
    'София': [42.6977, 23.3219],
    'Пловдив': [42.1354, 24.7453],
    'Варна': [43.2140, 27.9103],
    'Бургас': [42.5048, 27.4626],
    'Русе': [43.8356, 25.9657],
    'Стара Загора': [42.4258, 25.6345],
    'Плевен': [43.4170, 24.6067],
    'Червен бряг': [43.2788, 24.0825],
    'Сливен': [42.6859, 26.3299],
    'Добрич': [43.5678, 27.8236],
    'Шумен': [43.2713, 26.9142],
    'Видин': [43.9942, 22.8736],
    'Благоевград': [42.0209, 23.0942],
    'Пазарджик': [42.1866, 24.3336],
    'Хасково': [41.9344, 25.5558]
  };
  var DEFAULT_CITY = 'Велико Търново';
  var CACHE_PREFIX = 'svetat-wx-';
  var CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  var CACHE_MAX_AGE = 6 * 60 * 60 * 1000; // older cached data is never shown
  var FETCH_TIMEOUT = 8000;

  // WMO weather codes in Bulgarian (description + emoji icon).
  var WMO = {
    0: ['☀️', 'Ясно'], 1: ['🌤️', 'Предимно слънчево'], 2: ['⛅', 'Частично облачно'], 3: ['☁️', 'Облачно'],
    45: ['🌫️', 'Мъгла'], 48: ['🌫️', 'Мъгла със слана'],
    51: ['🌦️', 'Ситен дъжд'], 53: ['🌦️', 'Ситен дъжд'], 55: ['🌦️', 'Постоянен ситен дъжд'],
    56: ['🌧️', 'Леден ситен дъжд'], 57: ['🌧️', 'Леден ситен дъжд'],
    61: ['🌧️', 'Слаб дъжд'], 63: ['🌧️', 'Дъжд'], 65: ['🌧️', 'Силен дъжд'],
    66: ['🌧️', 'Леден дъжд'], 67: ['🌧️', 'Леден дъжд'],
    71: ['🌨️', 'Слаб снеговалеж'], 73: ['🌨️', 'Снеговалеж'], 75: ['❄️', 'Силен снеговалеж'],
    77: ['🌨️', 'Снежни зърна'],
    80: ['🌦️', 'Превалявания'], 81: ['🌦️', 'Превалявания'], 82: ['⛈️', 'Силни превалявания'],
    85: ['🌨️', 'Снежни превалявания'], 86: ['🌨️', 'Силни снежни превалявания'],
    95: ['⛈️', 'Гръмотевична буря'], 96: ['⛈️', 'Буря с градушка'], 99: ['⛈️', 'Силна буря с градушка']
  };
  function describe(code) { return WMO[code] || ['🌡️', 'Променливо време']; }

  function buildUrl(city) {
    var c = CITIES[city] || CITIES[DEFAULT_CITY];
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + c[0] + '&longitude=' + c[1] +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&timezone=Europe%2FSofia&forecast_days=4';
  }

  // Pure transform: API JSON -> render model (unit-testable without a browser).
  function toModel(json) {
    var cur = json && json.current ? json.current : {};
    var d = json && json.daily ? json.daily : {};
    var times = d.time || [];
    var days = [];
    for (var i = 1; i <= 3 && i < times.length; i++) {
      days.push({
        date: times[i],
        max: d.temperature_2m_max ? d.temperature_2m_max[i] : null,
        min: d.temperature_2m_min ? d.temperature_2m_min[i] : null,
        rain: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
        code: d.weather_code ? d.weather_code[i] : null,
        icon: d.weather_code ? describe(d.weather_code[i])[0] : '🌡️'
      });
    }
    return {
      fetchedAt: Date.now(),
      temp: cur.temperature_2m, feels: cur.apparent_temperature,
      humidity: cur.relative_humidity_2m, wind: cur.wind_speed_10m,
      code: cur.weather_code, time: cur.time, days: days
    };
  }

  // A model is usable only if the temperature is a number and the three
  // forecast days are exactly tomorrow and the two days after it (Sofia time).
  function validModel(m) {
    if (!m || !Number.isFinite(m.temp) || !m.days || m.days.length !== 3) return false;
    var p = sofiaToday().split('-').map(Number); // [year, month, day]; months are 1-based
    var base = Date.UTC(p[0], p[1] - 1, p[2]);
    for (var i = 0; i < 3; i++) {
      var expected = new Date(base + (i + 1) * 86400000).toISOString().slice(0, 10);
      if (m.days[i].date !== expected) return false;
      if (!Number.isFinite(m.days[i].min) || !Number.isFinite(m.days[i].max)) return false;
    }
    return true;
  }

  // Today's date (YYYY-MM-DD) in the Europe/Sofia timezone.
  function sofiaToday() {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    var v = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value || ''; };
    return [v('year'), v('month'), v('day')].join('-');
  }

  function dayLabel(isoDate) {
    var d = new Date(isoDate + 'T12:00:00');
    if (!Number.isFinite(d.getTime())) return '';
    var name = new Intl.DateTimeFormat('bg-BG', { weekday: 'long' }).format(d);
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function fmt(value, unit) {
    return (value === null || value === undefined || !Number.isFinite(value)) ? '—' : Math.round(value) + unit;
  }

  function readCache(city) {
    try {
      var raw = JSON.parse(localStorage.getItem(CACHE_PREFIX + city) || 'null');
      if (raw && typeof raw === 'object' && Number.isFinite(raw.fetchedAt) && Array.isArray(raw.days) && raw.days.length === 3 &&
          Number.isFinite(raw.temp) && raw.days.every(function (d) { return d && /^\d{4}-\d{2}-\d{2}$/.test(d.date); })) {
        // Drop caches older than the maximum age, or whose forecast no longer
        // starts after today (a cache from before midnight is stale).
        var expired = (Date.now() - raw.fetchedAt) > CACHE_MAX_AGE ||
          raw.days[0].date <= sofiaToday();
        if (!expired) return raw;
      }
    } catch (e) { /* corrupted cache is ignored */ }
    return null;
  }
  function writeCache(city, model) {
    try { localStorage.setItem(CACHE_PREFIX + city, JSON.stringify(model)); } catch (e) { /* storage full or blocked */ }
  }

  var activeController = null; // cancelled when a newer request starts

  function fetchJson(url) {
    if (activeController) { try { activeController.abort(); } catch (e) { /* ignore */ } }
    activeController = new AbortController();
    var controller = activeController;
    var timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* ignore */ } }, FETCH_TIMEOUT);
    try {
      return fetch(url, { signal: controller.signal, cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .finally(function () {
          clearTimeout(timer);
          if (activeController === controller) activeController = null;
        });
    } catch (e) { clearTimeout(timer); return Promise.reject(e); }
  }

  // DOM helpers (kept minimal; no innerHTML with API data).
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderModel(model, city, stale) {
    var body = document.getElementById('wx-body');
    var note = document.getElementById('wx-note');
    if (!body || !model) return;
    body.replaceChildren();
    body.className = 'wx-body';

    var state = describe(model.code);
    var now = el('div', 'wx-now');
    now.append(el('span', 'wx-emoji', state[0]));
    var nowInfo = el('div');
    nowInfo.append(el('div', 'wx-temp', fmt(model.temp, '°')));
    nowInfo.append(el('div', 'wx-desc', state[1] + ' · усеща се ' + fmt(model.feels, '°') +
      ' · вятър ' + fmt(model.wind, ' км/ч') + ' · влажност ' + fmt(model.humidity, '%')));
    now.append(nowInfo);
    body.append(now);

    var days = el('div', 'wx-days');
    for (var i = 0; i < model.days.length; i++) {
      var day = model.days[i];
      var box = el('div', 'wx-day');
      var label = describe(day.code)[1];
      if (label) box.title = label; // Bulgarian description on hover/tap
      box.append(el('div', 'wx-day-name', dayLabel(day.date) || 'Ден ' + (i + 1)));
      box.append(el('div', 'wx-day-emoji', day.icon));
      box.append(el('div', 'wx-day-cond', label || '—'));
      box.append(el('div', 'wx-day-temp', fmt(day.min, '°') + ' … ' + fmt(day.max, '°')));
      box.append(el('div', 'wx-day-rain', '💧 ' + fmt(day.rain, '%')));
      days.append(box);
    }
    body.append(days);

    if (note) {
      note.replaceChildren();
      var when = new Intl.DateTimeFormat('bg-BG', {
        dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Sofia'
      }).format(new Date(model.fetchedAt));
      if (stale) note.append(document.createTextNode('⚠️ Времето не се обнови — показани са данни от ' + when + '. Новините работят нормално. '));
      else note.append(document.createTextNode('Обновено: ' + when + ' · Източник: '));
      var credit = el('a', null, 'Open-Meteo');
      credit.href = 'https://open-meteo.com/'; credit.target = '_blank'; credit.rel = 'noopener noreferrer';
      note.append(credit);
      note.append(document.createTextNode(' (CC-BY 4.0 '));
      var license = el('a', null, 'лиценз');
      license.href = 'https://creativecommons.org/licenses/by/4.0/deed.bg';
      license.target = '_blank'; license.rel = 'noopener noreferrer';
      note.append(license);
      note.append(document.createTextNode(')'));
    }
  }

  // Loading placeholder while a new city is being fetched (no stale data shown).
  function renderLoading(city) {
    var body = document.getElementById('wx-body');
    if (body) {
      body.className = 'wx-body';
      body.replaceChildren(el('span', 'wx-desc', '⏳ Зареждам времето за ' + city + '…'));
    }
  }

  function renderError(city) {
    var body = document.getElementById('wx-body');
    if (body) {
      body.className = 'wx-body wx-error';
      body.replaceChildren(el('span', 'wx-desc',
        '⚠️ Времето временно не е достъпно. Новините работят нормално.'));
    }
    var note = document.getElementById('wx-note');
    if (note) note.textContent = 'Опитай отново след минута или провери времето директно в Open-Meteo.';
  }

  // Only the most recent request may render; older ones are ignored.
  var requestSeq = 0;

  function loadWeather(city, force) {
    var mine = ++requestSeq;
    var cached = readCache(city);
    var fresh = cached && (Date.now() - cached.fetchedAt) < CACHE_TTL;
    if (cached) renderModel(cached, city, false); // instant paint from cache
    else renderLoading(city); // never show another city's data while loading
    if (fresh && !force) return;
    fetchJson(buildUrl(city))
      .then(function (json) {
        if (mine !== requestSeq) return; // superseded by a newer request
        var model = toModel(json);
        if (!validModel(model)) throw new Error('Invalid response');
        writeCache(city, model);
        renderModel(model, city, false);
      })
      .catch(function () {
        if (mine !== requestSeq) return; // superseded by a newer request
        // Weather is optional: on failure show the last good cache marked as
        // stale, or a short note — but never break the news.
        if (cached) renderModel(cached, city, true);
        else renderError(city);
      });
  }

  function init() {
    var root = document.getElementById('wx');
    if (!root) return;
    var select = document.getElementById('wx-city');
    if (!select) return;
    var saved = null;
    try { saved = localStorage.getItem(CACHE_PREFIX + 'city'); } catch (e) { /* ignore */ }
    var city = CITIES[saved] ? saved : DEFAULT_CITY;
    for (var name in CITIES) {
      var option = document.createElement('option');
      option.value = name; option.textContent = name;
      select.append(option);
    }
    select.value = city;
    select.addEventListener('change', function () {
      try { localStorage.setItem(CACHE_PREFIX + 'city', select.value); } catch (e) { /* ignore */ }
      loadWeather(select.value, true);
    });
    loadWeather(city, false);
    // Refresh at most twice an hour, only when the tab is visible.
    setInterval(function () {
      if (document.visibilityState === 'visible') loadWeather(select.value, true);
    }, 30 * 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
