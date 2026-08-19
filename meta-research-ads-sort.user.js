// ==UserScript==
// @name         Meta Research - Sort by Ad Count
// @namespace    meta.research.local
// @version      0.1.0
// @description  Adds an N. ADS sorting view to Meta Research Opportunity Radar
// @match        https://www.facebook.com/ads/library/*
// @match        https://*.facebook.com/ads/library/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/menteora/tamper-ads/main/meta-research-ads-sort.user.js
// @downloadURL  https://raw.githubusercontent.com/menteora/tamper-ads/main/meta-research-ads-sort.user.js
// ==/UserScript==

(function () {
  'use strict';

  var BUTTON_ID = 'mr-sort-ads-count';
  var sortActive = false;
  var sorting = false;

  function findRadarPanel() {
    var strongs = document.querySelectorAll('strong');
    for (var i = 0; i < strongs.length; i++) {
      var text = String(strongs[i].textContent || '');
      if (text.indexOf('Opportunity Radar') === 0) {
        var node = strongs[i];
        while (node && node !== document.body) {
          if (node.style && node.style.position === 'fixed') return node;
          node = node.parentElement;
        }
      }
    }
    return null;
  }

  function findFilterRow(panel) {
    if (!panel) return null;
    var buttons = panel.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (String(buttons[i].textContent || '').trim() === 'TOP') {
        return buttons[i].parentElement;
      }
    }
    return null;
  }

  function findList(panel) {
    if (!panel) return null;
    var divs = panel.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
      var s = divs[i].style;
      if (s && s.position === 'absolute' && (s.overflow === 'auto' || s.overflowY === 'auto')) {
        return divs[i];
      }
    }
    return null;
  }

  function adCount(card) {
    var text = String(card.textContent || '');
    var m = text.match(/(?:^|\s)(\d+)\s+ADS(?:\s|$)/i);
    return m ? parseInt(m[1], 10) || 0 : 0;
  }

  function score(card) {
    try {
      var head = card.firstElementChild;
      var value = head && head.lastElementChild ? parseInt(head.lastElementChild.textContent, 10) : 0;
      return isFinite(value) ? value : 0;
    } catch (e) {
      return 0;
    }
  }

  function sortCards() {
    if (!sortActive || sorting) return;

    var panel = findRadarPanel();
    var list = findList(panel);
    if (!list) return;

    var cards = Array.prototype.slice.call(list.children || []);
    if (cards.length < 2) return;

    sorting = true;

    cards.sort(function (a, b) {
      var adDiff = adCount(b) - adCount(a);
      if (adDiff !== 0) return adDiff;
      return score(b) - score(a);
    });

    for (var i = 0; i < cards.length; i++) {
      list.appendChild(cards[i]);
    }

    sorting = false;
  }

  function styleButton(btn, active) {
    btn.style.marginRight = '5px';
    btn.style.marginTop = '5px';
    btn.style.fontWeight = active ? 'bold' : '';
    btn.style.border = active ? '2px solid #f2c94c' : '';
  }

  function installButton() {
    var panel = findRadarPanel();
    var row = findFilterRow(panel);
    if (!row) return;

    var existing = document.getElementById(BUTTON_ID);
    if (existing) {
      styleButton(existing, sortActive);
      if (sortActive) sortCards();
      return;
    }

    var btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.textContent = 'N. ADS ↓';
    btn.title = 'Ordina dal maggior numero di ads al minore';
    styleButton(btn, sortActive);

    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      sortActive = true;
      styleButton(btn, true);
      sortCards();
    });

    row.appendChild(btn);

    row.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || target.id === BUTTON_ID) return;
      if (target.tagName === 'BUTTON') {
        sortActive = false;
        var ours = document.getElementById(BUTTON_ID);
        if (ours) styleButton(ours, false);
      }
    }, true);
  }

  var observer = new MutationObserver(function () {
    if (sorting) return;
    installButton();
    if (sortActive) sortCards();
  });

  function start() {
    installButton();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    setInterval(function () {
      installButton();
      if (sortActive) sortCards();
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
