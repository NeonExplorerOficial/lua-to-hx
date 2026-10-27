(function () {
  'use strict';

  var L = window.Lua2Hx;
  var $ = function (id) { return document.getElementById(id); };

  var input = $('input');
  var output = $('output');
  var engineSel = $('engine');
  var indentSel = $('indent');
  var strict = $('strict');
  var header = $('header');
  var status = $('status');
  var info = $('engineInfo');
  var downloadBtn = $('download');
  var copyBtn = $('copy');

  var baseName = 'script';

  var EXAMPLE = [
    "-- Ejemplo de stage para Psych Engine",
    "function onCreate()",
    "    makeLuaSprite('bg', 'stageback', -600, -300)",
    "    setScrollFactor('bg', 0.9, 0.9)",
    "    addLuaSprite('bg', false)",
    "",
    "    makeLuaSprite('fade', nil, 0, 0)",
    "    makeGraphic('fade', 1280, 720, '000000')",
    "    setObjectCamera('fade', 'hud')",
    "    addLuaSprite('fade', true)",
    "    doTweenAlpha('fadeOut', 'fade', 0, 1.5, 'quadOut')",
    "end",
    "",
    "local zoomAmount = 0.05",
    "",
    "function onBeatHit()",
    "    if curBeat % 4 == 0 then",
    "        setProperty('camGame.zoom', getProperty('camGame.zoom') + zoomAmount)",
    "    end",
    "end",
    "",
    "function goodNoteHit(id, direction, noteType, isSustainNote)",
    "    if not isSustainNote then",
    "        debugPrint('nota ' .. direction)",
    "    end",
    "end",
    ""
  ].join('\n');

  /* ---- ajustes guardados (opcional) ---- */
  function load(k, d) {
    try { var v = localStorage.getItem('lua2hx.' + k); return v === null ? d : v; } catch (e) { return d; }
  }
  function save(k, v) {
    try { localStorage.setItem('lua2hx.' + k, v); } catch (e) { /* sin almacenamiento */ }
  }

  /* ---- motores ---- */
  var order = ['psych', 'vslice', 'generic'];
  Object.keys(L.profiles).forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
  order.forEach(function (id) {
    var p = L.profiles[id];
    if (!p) return;
    var o = document.createElement('option');
    o.value = id;
    o.textContent = p.label;
    engineSel.appendChild(o);
  });
  engineSel.value = load('engine', 'psych');
  if (!L.profiles[engineSel.value]) engineSel.value = 'psych';
  indentSel.value = load('indent', '4');
  strict.checked = load('strict', '1') === '1';
  header.checked = load('header', '1') === '1';

  function indentText() {
    return indentSel.value === 'tab' ? '\t' : ' '.repeat(Number(indentSel.value));
  }

  /* ---- conversión ---- */
  var timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 200);
  }

  function lineStart(text, line) {
    var idx = 0;
    for (var i = 1; i < line; i++) {
      var n = text.indexOf('\n', idx);
      if (n < 0) return text.length;
      idx = n + 1;
    }
    return idx;
  }

  function jumpTo(line) {
    var text = input.value;
    var s = lineStart(text, line);
    var e = text.indexOf('\n', s);
    if (e < 0) e = text.length;
    input.focus();
    input.setSelectionRange(s, e);
    var lh = parseFloat(getComputedStyle(input).lineHeight) || 20;
    input.scrollTop = Math.max(0, (line - 4) * lh);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function run() {
    var src = input.value;
    status.textContent = '';
    if (!src.trim()) {
      output.value = '';
      downloadBtn.disabled = true;
      copyBtn.disabled = true;
      return;
    }
    var r;
    try {
      r = L.convert(src, {
        profile: engineSel.value,
        indent: indentText(),
        strictTruthiness: strict.checked,
        header: header.checked
      });
    } catch (e) {
      output.value = '';
      var b = el('div', 'banner err');
      b.appendChild(el('h3', null, 'Error interno del convertidor'));
      b.appendChild(el('div', null, String(e && e.message || e)));
      status.appendChild(b);
      downloadBtn.disabled = true;
      copyBtn.disabled = true;
      return;
    }
    if (r.error) {
      output.value = '';
      downloadBtn.disabled = true;
      copyBtn.disabled = true;
      var eb = el('div', 'banner err');
      eb.appendChild(el('h3', null, 'No se pudo leer el Lua'));
      var row = el('div', null, r.error + ' ');
      if (r.line) {
        var go = el('button', 'linkbtn', 'ir a la línea');
        go.type = 'button';
        go.addEventListener('click', function () { jumpTo(r.line); });
        row.appendChild(go);
      }
      eb.appendChild(row);
      status.appendChild(eb);
      return;
    }
    output.value = r.code;
    downloadBtn.disabled = false;
    copyBtn.disabled = false;

    if (!r.warnings.length) {
      var ok = el('div', 'banner ok');
      ok.appendChild(el('div', null, 'Conversión lista, sin avisos. Pruébala en el juego antes de darla por buena.'));
      status.appendChild(ok);
      return;
    }
    var wb = el('div', 'banner warn');
    wb.appendChild(el('h3', null, r.warnings.length + (r.warnings.length === 1 ? ' aviso' : ' avisos') + ' para revisar'));
    var ul = el('ul');
    r.warnings.forEach(function (w) {
      var li = el('li');
      if (w.line) {
        var b2 = el('button', 'linkbtn', 'línea ' + w.line);
        b2.type = 'button';
        b2.addEventListener('click', function () { jumpTo(w.line); });
        li.appendChild(b2);
      }
      li.appendChild(el('span', null, w.msg));
      ul.appendChild(li);
    });
    wb.appendChild(ul);
    status.appendChild(wb);
  }

  function updateInfo() {
    var p = L.profiles[engineSel.value];
    info.textContent = p ? p.description : '';
    downloadBtn.textContent = 'Descargar .' + (p ? p.extension : 'hx');
  }

  /* ---- eventos ---- */
  input.addEventListener('input', schedule);
  engineSel.addEventListener('change', function () { save('engine', engineSel.value); updateInfo(); run(); });
  indentSel.addEventListener('change', function () { save('indent', indentSel.value); run(); });
  strict.addEventListener('change', function () { save('strict', strict.checked ? '1' : '0'); run(); });
  header.addEventListener('change', function () { save('header', header.checked ? '1' : '0'); run(); });

  $('example').addEventListener('click', function () {
    input.value = EXAMPLE;
    baseName = 'ejemplo';
    run();
  });
  $('clear').addEventListener('click', function () {
    input.value = '';
    baseName = 'script';
    run();
    input.focus();
  });

  function readFile(file) {
    if (!file) return;
    var rd = new FileReader();
    rd.onload = function () {
      input.value = String(rd.result);
      baseName = file.name.replace(/\.[^.]+$/, '') || 'script';
      run();
    };
    rd.readAsText(file);
  }
  $('file').addEventListener('change', function (e) {
    readFile(e.target.files[0]);
    e.target.value = '';
  });

  var inPane = input.closest('.pane');
  ['dragenter', 'dragover'].forEach(function (ev) {
    inPane.addEventListener(ev, function (e) { e.preventDefault(); inPane.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    inPane.addEventListener(ev, function (e) { e.preventDefault(); inPane.classList.remove('drag'); });
  });
  inPane.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    readFile(f);
  });

  copyBtn.addEventListener('click', function () {
    var text = output.value;
    var done = function () {
      var old = copyBtn.textContent;
      copyBtn.textContent = '¡Copiado!';
      setTimeout(function () { copyBtn.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { output.select(); document.execCommand('copy'); done(); });
    } else {
      output.select();
      document.execCommand('copy');
      done();
    }
  });

  downloadBtn.addEventListener('click', function () {
    var p = L.profiles[engineSel.value];
    var blob = new Blob([output.value], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = baseName + '.' + (p ? p.extension : 'hx');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  updateInfo();
  run();
})();
