/* ============================================================
   mcode-docs · 交互脚本
   纯 vanilla JS，无依赖、无构建步骤、可在 file:// 下运行。
   搜索索引在加载时从 DOM 构建，不含硬编码的重复数据。
   ============================================================ */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;

  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

  /* ---------------------------------------------------------
     1. 深色 / 浅色主题
     --------------------------------------------------------- */
  var THEME_KEY = 'mcode-docs-theme';

  function currentTheme() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  // 首访刻意不读 prefers-color-scheme：只认用户自己存下来的选择。
  // 存的是 'dark' 才用深色，其余（含首次访问）一律浅色。
  function storedTheme() {
    try {
      var v = localStorage.getItem(THEME_KEY);
      return v === 'dark' ? 'dark' : 'light';
    } catch (e) { return 'light'; }   // file:// 下可能不可读
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    var toggle = $('#themeToggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      toggle.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
    }
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* file:// 下可能不可写，忽略 */ }
  }

  var themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
  }
  applyTheme(storedTheme());

  /* ---------------------------------------------------------
     2. 标题锚点链接
     --------------------------------------------------------- */
  var ANCHORABLE = '.page-title, .h2, .h3, .h4';
  // 把每个分支都限定在 #main 内（直接拼接只会在第一段生效）
  var ANCHOR_SCOPED = ANCHORABLE.split(',')
    .map(function (sel) { return '#main ' + sel.trim(); })
    .join(', ');
  $$('#main ' + ANCHORABLE).forEach(function (h) {
    if (!h.id) { return; }
    var a = doc.createElement('a');
    a.className = 'anchor';
    a.href = '#' + h.id;
    a.setAttribute('aria-label', '链接到此小节：' + (h.textContent || '').trim());
    a.textContent = '#';
    h.appendChild(a);
  });

  /* ---------------------------------------------------------
     3. 代码块复制按钮（含 file:// 下的兼容回退）
     --------------------------------------------------------- */
  function legacyCopy(text) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);

    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = doc.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    doc.body.removeChild(ta);
    return ok;
  }

  function writeClipboard(text) {
    // 优先使用 Clipboard API；在 file:// 等非安全上下文中回退。
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  // 复制按钮按官方代码块实测做成 26x26 纯图标按钮，不放文字。
  // 三个状态各一枚图标：待复制 / 已完成 / 失败；文案只留在 aria-label 与 title 上。
  var ICON_COPY = '<path d="M9 9.5A2.5 2.5 0 0111.5 7h6A2.5 2.5 0 0120 9.5v6a2.5 2.5 0 01-2.5 2.5h-6A2.5 2.5 0 019 15.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M15 7V6.5A2.5 2.5 0 0012.5 4h-6A2.5 2.5 0 004 6.5v6A2.5 2.5 0 006.5 15H7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>';
  var ICON_DONE = '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>';
  var ICON_FAIL = '<path d="M12 7.5v5.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.05" fill="currentColor"/>';

  function makeIcon(paths) {
    var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = paths;
    return svg;
  }

  function flashButton(btn, ok) {
    var original = btn.getAttribute('data-label') || '复制';
    btn.textContent = '';
    btn.appendChild(makeIcon(ok ? ICON_DONE : ICON_FAIL));
    btn.setAttribute('aria-label', ok ? '已复制' : '复制失败');
    btn.setAttribute('title', ok ? '已复制' : '复制失败');
    btn.classList.add('is-done');
    if (!ok) { btn.classList.add('is-fail'); }
    window.clearTimeout(btn._t);
    btn._t = window.setTimeout(function () {
      btn.textContent = '';
      btn.appendChild(makeIcon(ICON_COPY));
      btn.setAttribute('aria-label', '复制此代码块内容');
      btn.setAttribute('title', '复制');
      btn.classList.remove('is-done');
      btn.classList.remove('is-fail');
    }, ok ? 1800 : 2400);
  }

  $$('.code-block').forEach(function (block) {
    var codeEl = $('pre > code', block);
    if (!codeEl) { return; }
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.appendChild(makeIcon(ICON_COPY));
    btn.setAttribute('data-label', '复制');
    btn.setAttribute('aria-label', '复制此代码块内容');
    btn.setAttribute('title', '复制');
    btn.addEventListener('click', function () {
      writeClipboard(codeEl.textContent).then(function (ok) {
        flashButton(btn, ok !== false);
      });
    });
    block.appendChild(btn);
  });

  /* ---------------------------------------------------------
     4. 标题清单（供滚动监听 / 大纲使用）
     --------------------------------------------------------- */
  var headings = $$('#main ' + ANCHORABLE).filter(function (h) { return !!h.id; });

  // 标题不是内容的祖先，只能按文档顺序找「最后一个排在 el 之前的标题」。
  function nearestHeading(el) {
    var best = null;
    for (var i = 0; i < headings.length; i++) {
      // headings 已是文档顺序；一旦某个标题不再位于 el 之前，后面的也不会是。
      if (headings[i].compareDocumentPosition(el) & 4 /* DOCUMENT_POSITION_FOLLOWING */) {
        best = headings[i];
      } else {
        break;
      }
    }
    return best;
  }

  function sectionOf(el) {
    var node = el;
    while (node && node !== doc.body) {
      if (node.classList && node.classList.contains('doc-section')) { return node; }
      node = node.parentNode;
    }
    return null;
  }

  // 每个标题下辖的正文（直到下一个标题为止）
  function bodyTextOf(heading) {
    var parts = [];
    var node = heading.nextElementSibling;
    while (node && !node.matches(ANCHOR_SCOPED)) {
      if (node.classList && (node.classList.contains('doc-section'))) { break; }
      parts.push(node.textContent || '');
      node = node.nextElementSibling;
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /* ---------------------------------------------------------
     5. 右侧「本页大纲」—— 从 DOM 构建
     --------------------------------------------------------- */
  var tocNav = $('#tocNav');
  var tocLinks = [];

  if (tocNav) {
    var currentGroup = null;
    headings.forEach(function (h) {
      var link = doc.createElement('a');
      link.href = '#' + h.id;
      link.textContent = (h.textContent || '').replace(/#$/, '').trim();
      link.dataset.target = h.id;
      tocNav.appendChild(link);
      tocLinks.push({ el: link, heading: h });

      if (h.classList.contains('h2')) {
        currentGroup = null;
        link.classList.add('toc-h2');
      } else {
        link.classList.add('toc-h3');
        if (!currentGroup) {
          currentGroup = doc.createElement('div');
          currentGroup.className = 'toc-group';
          tocNav.appendChild(currentGroup);
        }
        currentGroup.appendChild(link);
      }
    });
  }

  /* ---------------------------------------------------------
     6. 滚动监听：侧栏 / 大纲 高亮
     --------------------------------------------------------- */
  var sidebarLinks = $$('.sidenav-list a');
  var sidebarByTarget = {};
  sidebarLinks.forEach(function (a) {
    var id = (a.getAttribute('href') || '').replace('#', '');
    if (!id) { return; }
    if (!sidebarByTarget[id]) { sidebarByTarget[id] = []; }
    sidebarByTarget[id].push(a);
  });

  var activeGroupId = null;

  function setCurrent(list, id) {
    list.forEach(function (a) {
      if (a.getAttribute('href') === '#' + id) {
        a.setAttribute('aria-current', 'true');
      } else {
        a.removeAttribute('aria-current');
      }
    });
  }

  function updateTocGroup(sectionId) {
    if (activeGroupId === sectionId) { return; }
    activeGroupId = sectionId;
    $$('.toc-group', tocNav).forEach(function (g) {
      g.hidden = g.dataset.owner !== sectionId;
    });
  }

  // 给每个 .toc-group 标注它属于哪个「章节」（section id，而不是标题 id）
  (function markGroups() {
    if (!tocNav) { return; }
    var owner = null;
    Array.prototype.forEach.call(tocNav.children, function (node) {
      if (node.classList && node.classList.contains('toc-h2')) {
        var h2 = doc.getElementById((node.getAttribute('href') || '').replace('#', ''));
        var sec = h2 ? sectionOf(h2) : null;
        owner = sec ? sec.id : '';
        node.dataset.section = owner;
      } else if (node.classList && node.classList.contains('toc-group')) {
        node.dataset.owner = owner || '';
        node.hidden = true;
      }
    });
    tocLinks.forEach(function (item) {
      var sec = sectionOf(item.heading);
      if (sec) { item.el.dataset.section = sec.id; }
    });
  })();

  var ticking = false;

  // 判定阈值必须不小于标题的 scroll-margin-top（吸顶导航高度 + 间距），
  // 否则点击锚点跳转后，当前小节会被判为「尚未进入」而高亮到上一节。
  function activeThreshold() {
    var navbar = $('#navbar');
    var h = navbar ? navbar.offsetHeight : 0;
    return h + 24;
  }

  function applyScrollState() {
    ticking = false;
    var threshold = activeThreshold();
    var current = headings.length ? headings[0] : null;

    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top - threshold <= 0) {
        current = headings[i];
      } else {
        break;
      }
    }

    // 滚到底部时强制选中最后一节：末尾章节往往比一屏短，
    // 标题永远越不过阈值线，否则子导航/侧栏的高亮会停在前一节。
    if (headings.length && window.innerHeight + window.scrollY >= doc.documentElement.scrollHeight - 2) {
      current = headings[headings.length - 1];
    }

    if (current) {
      tocLinks.forEach(function (item) {
        if (item.heading === current) {
          item.el.setAttribute('aria-current', 'true');
        } else {
          item.el.removeAttribute('aria-current');
        }
      });
      var sec = sectionOf(current);
      if (sec) {
        Object.keys(sidebarByTarget).forEach(function (id) {
          setCurrent(sidebarByTarget[id], id);
        });
        setCurrent(sidebarLinks, sec.id);
        updateTocGroup(sec.id);
      }
    }
  }

  function onScroll() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(applyScrollState);
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function () {
    if (!ticking) { ticking = true; window.requestAnimationFrame(applyScrollState); }
  });

  /* ---------------------------------------------------------
     7. 移动端侧栏抽屉
     --------------------------------------------------------- */
  var sidebar = $('#sidebar');
  var navToggle = $('#navToggle');
  var scrim = $('#scrim');

  function setDrawer(open) {
    if (!sidebar || !navToggle) { return; }
    sidebar.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? '关闭侧边导航' : '打开侧边导航');
    if (scrim) { scrim.hidden = !open; }
  }

  if (navToggle) {
    navToggle.addEventListener('click', function () {
      setDrawer(!sidebar.classList.contains('is-open'));
    });
  }
  if (scrim) { scrim.addEventListener('click', function () { setDrawer(false); }); }

  // 移动端点击导航后自动收起抽屉
  $$('.sidenav-list a').forEach(function (a) {
    a.addEventListener('click', function () {
      if (window.innerWidth <= 1024) { setDrawer(false); }
    });
  });

  /* ---------------------------------------------------------
     8. 客户端搜索（索引来自 DOM）
     --------------------------------------------------------- */
  var searchModal = $('#searchModal');
  var searchInput = $('#searchInput');
  var searchResults = $('#searchResults');
  var searchTrigger = $('#searchTrigger');
  var searchClose = $('#searchClose');
  var searchBackdrop = $('#searchBackdrop');

  var entries = [];
  var selected = -1;
  var lastFocused = null;

  function snippetFor(el, query) {
    var host = el.closest ? (el.closest('tr') || el.closest('li') || el.closest('p') || el) : el;
    var text = (host.textContent || '').replace(/\s+/g, ' ').trim();
    var at = query ? text.toLowerCase().indexOf(query) : -1;
    if (at < 0) {
      return text.length > 130 ? text.slice(0, 130) + '…' : text;
    }
    var start = Math.max(0, at - 44);
    var out = (start > 0 ? '…' : '') + text.slice(start, start + 140) + (start + 140 < text.length ? '…' : '');
    return out;
  }

  function buildIndex() {
    entries = [];

    headings.forEach(function (h) {
      var title = (h.textContent || '').replace(/#$/, '').trim();
      entries.push({
        id: h.id,
        title: title,
        kind: h.classList.contains('h2') ? '章节'
          : h.classList.contains('page-title') ? '首页'
            : h.classList.contains('h3') ? '小节' : '条目',
        text: bodyTextOf(h).toLowerCase(),
        titleLc: title.toLowerCase(),
        el: h,
        isCommand: false
      });
    });

    // 命令名：所有以 / 开头的行内代码
    $$('#main code').forEach(function (codeEl) {
      var name = (codeEl.textContent || '').trim();
      if (name.charAt(0) !== '/' || name.length < 2 || name.length > 40) { return; }
      if (name.indexOf(' ') !== -1) { return; }
      var head = nearestHeading(codeEl);
      if (!head) { return; }
      entries.push({
        id: head.id,
        title: name,
        kind: '命令',
        text: '',
        titleLc: name.toLowerCase(),
        el: codeEl,
        isCommand: true
      });
    });
  }

  function score(entry, q) {
    if (entry.titleLc === q) { return 100; }
    if (entry.titleLc.indexOf(q) === 0) { return 82; }
    if (entry.isCommand && entry.titleLc.indexOf(q) === 0) { return 76; }
    if (entry.titleLc.indexOf(q) !== -1) { return 62; }
    if (entry.text.indexOf(q) !== -1) { return 30; }
    return 0;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlight(text, q) {
    var at = text.toLowerCase().indexOf(q);
    if (at < 0) { return escapeHtml(text); }
    return escapeHtml(text.slice(0, at)) +
      '<mark>' + escapeHtml(text.slice(at, at + q.length)) + '</mark>' +
      escapeHtml(text.slice(at + q.length));
  }

  function renderResults(q) {
    if (!searchResults) { return; }
    searchResults.innerHTML = '';
    selected = -1;
    if (!q) {
      searchInput.setAttribute('aria-expanded', 'false');
      return;
    }

    var hits = [];
    for (var i = 0; i < entries.length; i++) {
      var s = score(entries[i], q);
      if (s > 0) { hits.push({ entry: entries[i], score: s }); }
    }
    hits.sort(function (a, b) {
      if (b.score !== a.score) { return b.score - a.score; }
      return a.entry.title.length - b.entry.title.length;
    });
    hits = hits.slice(0, 20);

    if (!hits.length) {
      var li = doc.createElement('li');
      li.className = 'search-empty';
      li.textContent = currentLang() === 'en'
        ? 'No matches for “' + q + '”.'
        : '没有匹配「' + q + '」的内容。';
      searchResults.appendChild(li);
      return;
    }

    hits.forEach(function (hit, idx) {
      var entry = hit.entry;
      var li = doc.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.className = 'search-result';
      li.dataset.index = String(idx);

      var title = doc.createElement('span');
      title.className = 'search-result-title';
      title.innerHTML = highlight(entry.title, q);
      var kind = doc.createElement('span');
      kind.className = 'search-result-kind';
      kind.textContent = entry.kind;
      title.appendChild(kind);
      li.appendChild(title);

      var snip = doc.createElement('span');
      snip.className = 'search-result-snippet';
      snip.innerHTML = highlight(snippetFor(entry.el, entry.isCommand ? entry.title.toLowerCase() : q), q);
      li.appendChild(snip);

      li.addEventListener('click', function () { goTo(hits[idx].entry); });
      li.addEventListener('mouseenter', function () { setSelected(idx); });
      searchResults.appendChild(li);
    });

    searchInput.setAttribute('aria-expanded', 'true');
    setSelected(0);
  }

  function setSelected(idx) {
    var items = $$('.search-result', searchResults);
    if (!items.length) { selected = -1; return; }
    idx = Math.max(0, Math.min(items.length - 1, idx));
    selected = idx;
    items.forEach(function (it, i) {
      it.setAttribute('aria-selected', i === idx ? 'true' : 'false');
    });
    if (items[idx] && items[idx].scrollIntoView) {
      items[idx].scrollIntoView({ block: 'nearest' });
    }
  }

  function goTo(entry) {
    closeSearch();
    var target = doc.getElementById(entry.id);
    if (!target) { return; }
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '#' + entry.id);
    } else {
      window.location.hash = entry.id;
    }
    var behavior = root.style.scrollBehavior || 'auto';
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });

    var mark = entry.isCommand ? entry.el : target;
    if (mark && mark.classList) {
      mark.classList.remove('flash');
      // 强制回流以便重复点击时重新播放高亮
      void mark.offsetWidth;
      mark.classList.add('flash');
      window.setTimeout(function () { mark.classList.remove('flash'); }, 1600);
    }
    void behavior;
  }

  function openSearch() {
    if (!searchModal) { return; }
    lastFocused = doc.activeElement;
    buildIndex();
    searchModal.hidden = false;
    searchResults.innerHTML = '';
    searchInput.value = '';
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.focus();
  }

  function closeSearch() {
    if (!searchModal || searchModal.hidden) { return; }
    searchModal.hidden = true;
    if (lastFocused && lastFocused.focus) { lastFocused.focus(); }
  }

  if (searchTrigger) { searchTrigger.addEventListener('click', openSearch); }
  if (searchClose) { searchClose.addEventListener('click', closeSearch); }
  if (searchBackdrop) { searchBackdrop.addEventListener('click', closeSearch); }

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      renderResults(searchInput.value.trim().toLowerCase());
    });
    searchInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        setSelected(selected + 1);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        setSelected(selected - 1);
      } else if (ev.key === 'Enter') {
        var items = $$('.search-result', searchResults);
        if (selected >= 0 && items[selected]) {
          ev.preventDefault();
          items[selected].click();
        }
      } else if (ev.key === 'Home') {
        if ($$('.search-result', searchResults).length) { ev.preventDefault(); setSelected(0); }
      } else if (ev.key === 'End') {
        var all = $$('.search-result', searchResults);
        if (all.length) { ev.preventDefault(); setSelected(all.length - 1); }
      }
    });
  }

  doc.addEventListener('keydown', function (ev) {
    var meta = ev.ctrlKey || ev.metaKey;
    if (meta && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      if (searchModal && searchModal.hidden) { openSearch(); } else { closeSearch(); }
      return;
    }
    if (ev.key === 'Escape') {
      if (searchModal && !searchModal.hidden) { closeSearch(); return; }
      setDrawer(false);
      return;
    }
    if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      var tag = (doc.activeElement && doc.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') { return; }
      ev.preventDefault();
      openSearch();
    }
  });

  // 关闭抽屉时把焦点交还给触发按钮
  if (navToggle) {
    navToggle.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { setDrawer(false); navToggle.focus(); }
    });
  }

  /* ---------------------------------------------------------
     9. 语言切换（i18n）
     --------------------------------------------------------- */
  // 双语言为两份独立 HTML：index.html（zh，默认入口）与 index.en.html（en），
  // 共用同一套 style.css 与 app.js。不用 fetch 加载语言包，
  // 是因为 fetch 在 file:// 下被浏览器拦截，双击打开必须可用。
  //
  // 不做任何语言自动判定：index.html 打开即中文，index.en.html 打开即英文。
  // 早前按 navigator.language 首访跳转，会让英文系统的用户打开中文入口却看到
  // 英文内容（URL 说中文、内容是英文）。此处以「打开哪份文件就是哪种语言」
  // 为唯一规则——确定性优先于猜测。
  var LANG_KEY = 'mcode-docs-lang';

  function currentLang() {
    return (root.getAttribute('lang') || 'zh').slice(0, 2).toLowerCase();
  }

  function writeLang(v) {
    try { localStorage.setItem(LANG_KEY, v); } catch (e) {}
  }

  var langSwitch = $('#langSwitch');
  if (langSwitch) {
    // 记录用户最后一次选择，仅用于展示偏好；不参与任何跳转判定
    langSwitch.addEventListener('click', function () { writeLang(currentLang() === 'zh' ? 'en' : 'zh'); });
  }

  /* ---------------------------------------------------------
     10. 初始化
     --------------------------------------------------------- */
  buildIndex();
  applyScrollState();
  window.addEventListener('load', applyScrollState);
})();
