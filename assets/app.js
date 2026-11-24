/* 校史回响 · 前端逻辑
   1) 中文分词（单字 + 二元词）  2) BM25 检索  3) 句子级抽取 + 引用标注
   4) 本地模式零联网；可选 AI 增强模式（用户自备 Key，仅存本机） */
(function () {
  'use strict';

  var CORPUS = window.CORPUS || [];
  var STOP_CHAR = '的了是在和与有我你他她它吗呢吧啊就都也还个这那之其';
  var STOP_WORD = ['什么','怎么','哪些','哪个','多少','请问','介绍','一下','关于','以及','这个','那个','如何','为什么','是不','不是','可以','我们','他们','能否','告诉','讲讲','说说','知道','学校'];
  var K1 = 1.4, B = 0.72;

  /* ---------- 分词与索引 ---------- */
  function tokenize(s) {
    s = String(s || '').toLowerCase();
    var latin = s.match(/[a-z0-9]{2,}/g) || [];
    var cjk = s.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/).filter(Boolean);
    var grams = [];
    cjk.forEach(function (w) {
      for (var i = 0; i < w.length; i++) {
        var c = w.charAt(i);
        if (STOP_CHAR.indexOf(c) === -1) grams.push(c);
        if (i < w.length - 1) {
          var bg = w.substring(i, i + 2);
          if (STOP_WORD.indexOf(bg) === -1 && STOP_CHAR.indexOf(bg.charAt(0)) === -1) grams.push(bg);
        }
      }
    });
    return latin.concat(grams);
  }
  function uniq(a) {
    var seen = {}, out = [];
    a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  var IDX = (function build() {
    var docs = [], df = {}, total = 0;
    CORPUS.forEach(function (c) {
      var body = c.text + ' ' + c.title + ' ' + (c.tags || []).join(' ') + ' ' + (c.year || '');
      var toks = tokenize(body), tf = {}, dl = toks.length;
      toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
      Object.keys(tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
      total += dl;
      docs.push({ c: c, tf: tf, dl: dl });
    });
    var N = docs.length, avgdl = total / N, idf = {};
    Object.keys(df).forEach(function (t) {
      idf[t] = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
    });
    return { docs: docs, idf: idf, avgdl: avgdl, N: N };
  })();

  function search(query, k) {
    var qs = uniq(tokenize(query));
    var res = [];
    IDX.docs.forEach(function (d) {
      var s = 0;
      qs.forEach(function (t) {
        var tf = d.tf[t];
        if (!tf) return;
        var w = IDX.idf[t] || 0;
        s += w * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * d.dl / IDX.avgdl));
        if (d.c.title.indexOf(t) >= 0 || (d.c.tags || []).join('').indexOf(t) >= 0) s += w * 0.55;
      });
      if (s > 0) res.push({ chunk: d.c, score: s });
    });
    res.sort(function (a, b) { return b.score - a.score; });
    return { hits: res.slice(0, k || 3), terms: qs, all: res };
  }

  /* ---------- 句子处理 ---------- */
  function splitSents(t) {
    return String(t).split(/(?<=[。；！？])/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 1; });
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function highlight(s, terms) {
    var out = esc(s);
    var hi = terms.filter(function (t) { return t.length >= 2 && (IDX.idf[t] || 0) >= 1.6; })
      .sort(function (a, b) { return b.length - a.length; });
    hi.forEach(function (t) {
      out = out.split(esc(t)).join('<mark>' + esc(t) + '</mark>');
    });
    return out.replace(/<mark><mark>/g, '<mark>').replace(/<\/mark><\/mark>/g, '</mark>');
  }
  function bestSentence(chunk, terms) {
    var ss = splitSents(chunk.text), best = null;
    ss.forEach(function (s) {
      var sc = 0;
      terms.forEach(function (t) { if (t.length >= 2 && s.indexOf(t) >= 0) sc += (IDX.idf[t] || 0.4); });
      sc = sc / (1 + s.length / 130);
      if (!best || sc > best.score) best = { s: s, score: sc };
    });
    return best || { s: chunk.text, score: 0 };
  }

  /* ---------- 回答组装 ---------- */
  function leadOf(chunk, terms) {
    var ss = splitSents(chunk.text), scored = [];
    ss.forEach(function (s) {
      var sc = 0;
      terms.forEach(function (t) { if (t.length >= 2 && s.indexOf(t) >= 0) sc += (IDX.idf[t] || 0.4); });
      scored.push({ s: s, score: sc / (1 + s.length / 160) });
    });
    var max = 0;
    scored.forEach(function (x) { if (x.score > max) max = x.score; });
    for (var i = 0; i < scored.length; i++) {
      if (scored[i].score >= max * 0.7 && scored[i].s.length >= 10) return scored[i];
    }
    return scored[0] || { s: chunk.text, score: 0 };
  }

  function hasTerm(chunk, t) {
    return chunk.text.indexOf(t) >= 0 || chunk.title.indexOf(t) >= 0 || (chunk.tags || []).join('').indexOf(t) >= 0;
  }
  function queryBg(terms) {
    return terms.filter(function (t) { return t.length >= 2 && IDX.idf[t] !== undefined; });
  }
  function trimLead(s, terms) {
    s = String(s).replace(/[；;]+$/, '。');
    if (s.length <= 200) return s;
    var pos = -1, best = 0;
    terms.forEach(function (t) {
      if (t.length < 2) return;
      var p = s.indexOf(t), w = IDX.idf[t] || 1;
      if (p >= 0 && w > best) { best = w; pos = p; }
    });
    if (pos < 0) pos = 0;
    var start = Math.max(0, pos - 52), end = Math.min(s.length, pos + 78);
    while (start < pos && '，。、；：'.indexOf(s.charAt(start)) < 0) start++;
    while (end > pos && '，。、；：'.indexOf(s.charAt(end - 1)) < 0) end--;
    if (end <= start) return s.slice(0, 120) + '…';
    return (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '');
  }

  function buildAnswer(q) {
    var r = search(q, 3);
    var t0 = performance.now();
    var ms = function () { return (performance.now() - t0).toFixed(1); };
    var bg = queryBg(r.terms);
    var gated = r.hits.length && bg.length && bg.some(function (t) { return hasTerm(r.hits[0].chunk, t); });
    if (!gated || r.hits[0].score < 1.35) {
      return { found: false, q: q, near: r.all.slice(0, 3), terms: r.terms, ms: ms() };
    }
    var top = r.hits[0].score;
    var tops = r.hits.filter(function (x, i) { return i === 0 || x.score >= top * 0.62; });
    var lead = leadOf(tops[0].chunk, r.terms);
    var points = [];
    for (var i = 1; i < tops.length && points.length < 2; i++) {
      var b = bestSentence(tops[i].chunk, r.terms);
      if (!b || b.s.length < 8) continue;
      if (!bg.some(function (t) { return b.s.indexOf(t) >= 0; })) continue;
      if (lead.s.indexOf(b.s) >= 0 || b.s.indexOf(lead.s) >= 0) continue;
      if (points.some(function (p) { return p.s === b.s; })) continue;
      points.push({ s: trimLead(b.s, r.terms), ref: i + 1, chunk: tops[i].chunk });
    }
    return {
      found: true, q: q, terms: r.terms,
      lead: { s: trimLead(lead.s, r.terms), score: lead.score },
      points: points,
      hits: r.hits.filter(function (x) { return x.score >= top * 0.5; }).slice(0, 3), ms: ms()
    };
  }

  /* ---------- 渲染 ---------- */
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  var chatEl = document.getElementById('chat');
  var heroEl = document.getElementById('hero');
  var statEl = document.getElementById('stat');
  var count = 0;

  function addUser(q) {
    chatEl.appendChild(el('<div class="msg user"><div class="who">我</div><div class="body">' + esc(q) + '</div></div>'));
  }

  function srcCard(i, chunk, excerpt) {
    return '<a class="src" href="' + chunk.src.url + '" target="_blank" rel="noopener">' +
      '<span class="idx">S' + chunk.id.replace('S', '') + '</span>' +
      '<span class="txt"><b>' + esc(chunk.title) + '</b>' +
      '<span>《' + esc(chunk.src.name) + '》· 截取：' + esc(excerpt.slice(0, 54)) + (excerpt.length > 54 ? '…' : '') + '</span></span></a>';
  }

  function renderLocal(a) {
    var h = '';
    if (a.found) {
      h += '<div class="card answer">';
      h += '<div class="head"><span class="t">校史回响</span><span class="m">' + (mode === 'ai' ? 'AI 增强' : '本地检索') + '</span><span class="m">依据 ' + a.hits.length + ' 段原文</span></div>';
      h += '<p class="lead">' + highlight(a.lead.s, a.terms) + '<sup class="cite">[S' + a.hits[0].chunk.id.replace('S', '') + ']</sup></p>';
      if (a.points.length) {
        h += '<ul class="points">';
        a.points.forEach(function (p) {
          h += '<li>' + highlight(p.s, a.terms) + '<sup class="cite">[S' + p.chunk.id.replace('S', '') + ']</sup></li>';
        });
        h += '</ul>';
      }
      h += '<div class="srcs"><div class="label">出处 · 点击原文核对</div>';
      var seen = {};
      a.hits.forEach(function (x) {
        if (seen[x.chunk.id]) return; seen[x.chunk.id] = 1;
        h += srcCard(x, x.chunk, x.chunk.text);
      });
      h += '</div>';
      h += '<div class="foot"><span>检索耗时 ' + (parseFloat(a.ms) < 1 ? '&lt;1' : Math.round(a.ms)) + ' ms</span><span>知识库 ' + CORPUS.length + ' 段</span><span>未联网 · 本地计算</span></div>';
      h += '</div>';
    } else {
      h += '<div class="card answer">';
      h += '<div class="head"><span class="t">校史回响</span><span class="m">未在知识库中找到可靠依据</span></div>';
      h += '<p class="lead">这个问题在现有校史资料里没有直接记载。为避免给出没有出处的答案，我不做推测。你可以换个问法，或从下面这几条最接近的记载入手。</p>';
      if (a.near.length) {
        h += '<div class="srcs"><div class="label">最接近的记载</div>';
        a.near.forEach(function (x) { h += srcCard(x, x.chunk, x.chunk.text); });
        h += '</div>';
      }
      h += '</div>';
    }
    return h;
  }

  async function ask(q) {
    if (!q.trim()) return;
    heroEl.style.display = 'none';
    addUser(q);
    var wrap = el('<div class="msg bot"><div class="who">响</div><div class="body"></div></div>');
    chatEl.appendChild(wrap);
    var body = wrap.querySelector('.body');
    body.innerHTML = '<div class="card"><div class="head"><span class="t">校史回响</span><span class="m">检索中…</span></div><p class="lead" style="color:var(--ink-3)">正在校史资料中定位相关原文</p></div>';

    var a = buildAnswer(q);
    var html = renderLocal(a);

    if (mode === 'ai' && cfg.key) {
      body.innerHTML = html;
      try {
        var aiText = await callAI(q, a.hits);
        if (aiText) {
          var card = body.querySelector('.card.answer');
          var head = card.querySelector('.head');
          head.querySelector('.m').textContent = 'AI 增强 · 已引用原文';
          var p = card.querySelector('.lead');
          p.innerHTML = aiText.replace(/\[S(\d+)\]/g, function (m, n) { return '<sup class="cite">[S' + n + ']</sup>'; });
          card.querySelector('.points').style.display = 'none';
        }
      } catch (e) {
        var tip = body.querySelector('.foot');
        if (tip) tip.insertAdjacentHTML('afterbegin', '<span style="color:#a3541f">AI 模式不可用：' + esc(String(e.message || e).slice(0, 60)) + '，已回退本地检索</span>');
      }
    } else {
      body.innerHTML = html;
    }

    count++;
    statEl.textContent = '已答 ' + count + ' 问 · 本地耗时 ' + (parseFloat(a.ms) < 1 ? '<1' : Math.round(a.ms)) + ' ms';
    var view = document.getElementById('view');
    view.scrollTop = view.scrollHeight;
  }

  /* ---------- AI 增强 ---------- */
  var cfg = { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: '' };
  try { cfg = Object.assign(cfg, JSON.parse(localStorage.getItem('xsh_cfg') || '{}')); } catch (e) {}

  async function callAI(q, hits) {
    if (!hits.length) throw new Error('无检索结果');
    var ctx = hits.map(function (x) {
      return '[S' + x.chunk.id.replace('S', '') + '] ' + x.chunk.title + '：' + x.chunk.text + '（来源：' + x.chunk.src.name + ' ' + x.chunk.src.url + '）';
    }).join('\n');
    var sys = '你是河北师范大学校史讲解员。只依据下面提供的资料回答，资料没有的内容直接说"资料中没有记载"，绝不推测或补充外部知识。回答2到4句，简洁书面语，每个事实句末用方括号标注依据，如[S3]。';
    var usr = '【资料】\n' + ctx + '\n\n【问题】' + q;
    var r = await fetch(cfg.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }]
      })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }

  /* ---------- 时间轴 ---------- */
  var TL = [
    ['1902', '顺天府学堂', '由顺天府尹创办于北京地安门外兵将局旧址，是学校最早的前身，学制4年。', 0],
    ['1906', '北洋女师范学堂', '创建于天津三马路，旋迁天纬路，是中国最早的女子师范学堂之一。', 0],
    ['1907', '顺天高等学堂', '由顺天府学堂在原址改设，辛亥革命后改称顺天高等学校。', 1],
    ['1913', '京兆公立第一中学', '由顺天高等学校改设，此后数度更名，1949年改称河北北京高级中学。', 1],
    ['1929', '河北女子师范学院', '由河北省第一女子师范学校改设，设国文、家政、英文、史地等7个系。', 0],
    ['1949', '河北师范学院（天津）', '学校改名河北师范学院，取消家政系，男女兼收。', 1],
    ['1951', '河北师范专科学校', '在河北北京高级中学基础上改建，初设数学、理化、生物三科。', 1],
    ['1952', '河北省教师进修学院', '河北教育学院的前身，校址在当时的省会保定市。', 1],
    ['1956', '石家庄师范学院组建', '天津河北师范学院5系与河北北京师范学院生物科迁石家庄裕华路组建；同年河北北京师范学院扩建。', 0],
    ['1960', '石家庄师范大学', '石家庄师范学院改名，增设中文、历史两系。', 1],
    ['1962', '河北师范大学（原）', '由石家庄师范大学改名，为当时河北省属6所重点大学之一。', 0],
    ['1984', '河北职业技术师范专科学校', '后定名河北师范大学职业技术师范学院，设财经、电子、机械餐旅等系。', 1],
    ['1996', '四校合并组建新的河北师范大学', '原河北师范大学、河北师范学院与河北教育学院、河北职业技术师范学院合并。', 0],
    ['2014', '河北省人民政府、教育部共建', '学校成为省部共建高校。', 0]
  ];
  function renderTL() {
    var box = document.getElementById('tl');
    box.innerHTML = TL.map(function (n, i) {
      return '<div class="node' + (n[3] ? ' minor' : '') + '">' +
        '<div class="yr">' + n[0] + '</div>' +
        '<h4>' + n[1] + '<span class="go" data-q="' + n[0] + '年' + n[1] + '是怎么回事？">问一问</span></h4>' +
        '<p>' + n[2] + '</p></div>';
    }).join('');
  }

  /* ---------- 知识库表 ---------- */
  function renderKB() {
    document.getElementById('kbBody').innerHTML = CORPUS.map(function (c) {
      return '<tr><td><b>S' + c.id.replace('S', '') + '</b></td><td>' + (c.year || '—') + '</td><td>' + esc(c.title) +
        '</td><td>' + esc(c.text.slice(0, 78)) + (c.text.length > 78 ? '…' : '') +
        '</td><td><a href="' + c.src.url + '" target="_blank" rel="noopener">' + esc(c.src.name) + '</a></td></tr>';
    }).join('');
  }

  /* ---------- 交互 ---------- */
  var mode = 'local';
  var input = document.getElementById('input');
  var view = document.getElementById('view');

  function switchTab(name) {
    document.querySelectorAll('.nav button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === name);
    });
    document.querySelectorAll('.pane').forEach(function (p) {
      p.classList.toggle('on', p.id === 'pane-' + name);
    });
    var titles = { chat: '对话 · 向校史提问', timeline: '时间轴 · 一百二十余年', kb: '知识库 · 可溯源原文', about: '关于与设置' };
    document.getElementById('viewTitle').textContent = titles[name] || '';
    document.querySelector('.dock').style.display = name === 'chat' ? '' : 'none';
    view.scrollTop = 0;
  }

  document.querySelectorAll('.nav button').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.dataset.tab); });
  });

  document.querySelectorAll('.mode button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.mode button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      mode = b.dataset.mode;
      document.getElementById('modeText').textContent = mode === 'ai' ? 'AI 增强（需 Key）' : '离线检索增强';
      document.getElementById('engineBadge').textContent = mode === 'ai' ? 'AI 增强 · 需本地 Key' : '本地检索 · 无需联网';
    });
  });

  document.getElementById('chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (b) ask(b.textContent);
  });
  document.getElementById('tl').addEventListener('click', function (e) {
    var g = e.target.closest('.go');
    if (g) { switchTab('chat'); ask(g.dataset.q); }
  });

  document.getElementById('send').addEventListener('click', function () { ask(input.value); input.value = ''; input.style.height = 'auto'; });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); input.value = ''; input.style.height = 'auto'; }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  document.getElementById('saveCfg').addEventListener('click', function () {
    cfg.base = document.getElementById('cfgBase').value || cfg.base;
    cfg.model = document.getElementById('cfgModel').value || cfg.model;
    cfg.key = document.getElementById('cfgKey').value || cfg.key;
    localStorage.setItem('xsh_cfg', JSON.stringify(cfg));
    this.textContent = '已保存';
    var self = this;
    setTimeout(function () { self.textContent = '保存设置'; }, 1200);
  });
  document.getElementById('clearCfg').addEventListener('click', function () {
    localStorage.removeItem('xsh_cfg');
    cfg = { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: '' };
    document.getElementById('cfgKey').value = '';
    document.getElementById('cfgBase').value = '';
    document.getElementById('cfgModel').value = '';
  });

  renderTL(); renderKB();
  document.getElementById('stat').textContent = '知识库 ' + CORPUS.length + ' 段 · 数据截至 2026.11';

  var params = new URLSearchParams(location.search);
  if (params.get('tab')) switchTab(params.get('tab'));
  if (params.get('q')) {
    var qq = params.get('q');
    setTimeout(function () { ask(qq); }, 30);
  }
  if (params.get('test')) {
    var QS = ['学校是哪一年创办的？', '校训是什么？', '抗战时期学校迁到了哪里？', '河北师范大学是哪几所学校合并的？', '邓颖超与师大有什么关系？', '校徽为什么用线装书？', '学校有几个校区，分别在哪儿？', '学校的校歌是什么？', '计算机专业哪一年设立？', '学校有几个博士点？'];
    var res = QS.map(function (q) {
      var a = buildAnswer(q);
      return { q: q, found: a.found, lead: a.found ? a.lead.s : '', points: a.found ? a.points.map(function (p) { return p.s; }) : [], hits: a.found ? a.hits.map(function (h) { return h.chunk.id + ':' + h.score.toFixed(2); }) : (a.near || []).map(function (h) { return h.chunk.id + ':' + h.score.toFixed(2); }) };
    });
    var pre = document.createElement('pre');
    pre.id = 'testout';
    pre.textContent = JSON.stringify(res, null, 1);
    document.body.appendChild(pre);
  }
  window.__ask = ask;
})();
