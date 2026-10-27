// Pruebas del convertidor. Ejecuta: node test/run.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('../src/lua2hx.js');
require('../src/profiles.js');

let passed = 0;
let failed = 0;

function conv(src, opts) {
  const r = L.convert(src, Object.assign({ header: false }, opts || {}));
  if (r.error) throw new Error('Error de conversión: ' + r.error);
  return r;
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       '));
  }
}

function has(code, snippet) {
  if (!code.includes(snippet)) throw new Error('Falta: ' + JSON.stringify(snippet) + '\n--- salida ---\n' + code);
}
function hasNot(code, snippet) {
  if (code.includes(snippet)) throw new Error('No debería estar: ' + JSON.stringify(snippet) + '\n--- salida ---\n' + code);
}
function warns(r, text) {
  if (!r.warnings.some((w) => w.msg.includes(text))) {
    throw new Error('Falta el aviso "' + text + '". Avisos: ' + JSON.stringify(r.warnings.map((w) => w.msg)));
  }
}

console.log('Lenguaje');

test('local, global y función', () => {
  const c = conv('local a = 1\nb = 2\nfunction f(x) return x + a end').code;
  has(c, 'var a = 1;');
  has(c, 'var b;'); // global declarada arriba
  has(c, 'b = 2;');
  has(c, 'function f(x) {');
  has(c, 'return x + a;');
});

test('if / elseif / else y operadores', () => {
  const c = conv('if a ~= 1 and b == nil then x() elseif c >= 2 then y() else z() end').code;
  has(c, 'if (a != 1 && b == null) {');
  has(c, '} else if (c >= 2) {');
  has(c, '} else {');
});

test('not y verdad de Lua (condiciones fieles)', () => {
  const c = conv('if not done then x() end\nif v then y() end\nif isOk then z() end').code;
  has(c, 'if (done == null || done == false) {');
  has(c, 'if (v != null && v != false) {');
  has(c, 'if (isOk) {'); // nombre claramente booleano
});

test('condiciones simples cuando se desactiva strict', () => {
  const c = conv('if v then y() end', { strictTruthiness: false }).code;
  has(c, 'if (v) {');
});

test('bucle numérico simple', () => {
  const c = conv('for i = 1, 10 do print(i) end').code;
  has(c, 'for (i in 1...11) {');
  has(c, 'trace(i);');
});

test('bucle numérico con límite variable', () => {
  const c = conv('for i = 1, n do end').code;
  has(c, 'for (i in 1...(n + 1)) {');
});

test('bucle numérico con paso negativo', () => {
  const c = conv('for i = 10, 1, -1 do print(i) end').code;
  has(c, 'while (__t1 >= __t2) {');
  has(c, 'var i = __t1;');
});

test('while y repeat-until', () => {
  const c = conv('while a < 3 do a = a + 1 end\nrepeat a = a - 1 until a <= 0').code;
  has(c, 'while (a < 3) {');
  has(c, 'a += 1;');
  has(c, 'while (true) {');
  has(c, 'if (a <= 0) break;');
});

test('ipairs sin índice -> for in', () => {
  const c = conv('local t = {1,2,3}\nfor _, v in ipairs(t) do print(v) end').code;
  has(c, 'for (v in t) {');
});

test('ipairs con índice 1-based', () => {
  const c = conv('local t = {1,2,3}\nfor i, v in ipairs(t) do print(i, v) end').code;
  has(c, 'for (__t1 in 0...t.length) {');
  has(c, 'var i = __t1 + 1;');
  has(c, 'var v = t[__t1];');
});

test('pairs sobre objeto', () => {
  const c = conv('local cfg = {a = 1}\nfor k, v in pairs(cfg) do print(k, v) end').code;
  has(c, 'for (k in Reflect.fields(cfg)) {');
  has(c, 'var v = Reflect.field(cfg, k);');
});

test('concatenación con ..', () => {
  const c = conv('local s = "a" .. 1 .. x\nlocal t = a .. b').code;
  has(c, 'var s = "a" + 1 + x;');
  has(c, 'var t = Std.string(a) + b;');
});

test('idiomas and/or', () => {
  const c = conv('local r = c and "a" or "b"\nlocal d = x or 5').code;
  has(c, 'var r = (c != null && c != false ? "a" : "b");');
  has(c, 'var d = (x != null && x != false ? x : 5);');
});

test('tablas: array, objeto y vacía', () => {
  const c = conv('local a = {1, 2, 3}\nlocal o = {x = 1, ["y z"] = 2}\nlocal e = {}\nlocal l = {}\ntable.insert(l, 5)\nlocal m = {}\nm.k = 1').code;
  has(c, 'var a = [1, 2, 3];');
  has(c, 'var o = {x: 1, "y z": 2};');
  has(c, 'var l = [];');
  has(c, 'var m = {};');
});

test('índices de arrays pasan de base 1 a base 0', () => {
  const c = conv('local t = {10, 20}\nlocal x = t[1]\nlocal i = 2\nlocal y = t[i]\nt[#t + 1] = 30').code;
  has(c, 'var x = t[0];');
  has(c, 'var y = t[i - 1];');
  has(c, 't[t.length] = 30;');
});

test('índice dinámico desconocido avisa', () => {
  const r = conv('local v = data[key]');
  warns(r, 'Índice dinámico');
});

test('métodos y strings', () => {
  const c = conv('local n = s:upper() .. #s\nlocal p = string.sub(s, 2, 4)').code;
  has(c, 's.toUpperCase()');
  has(c, 's.length');
  has(c, 's.substring(1, 4)');
});

test('librería math y table', () => {
  const c = conv('local a = math.floor(x) + math.max(1, 2)\nlocal b = math.pi\ntable.insert(t, 1)\ntable.remove(t, 1)\nlocal j = table.concat(t, ",")\nlocal r = math.random(1, 5)').code;
  has(c, 'Math.floor(x) + Math.max(1, 2)');
  has(c, 'Math.PI');
  has(c, 't.push(1);');
  has(c, 't.splice(0, 1)[0]');
  has(c, 't.join(",")');
  has(c, 'Std.random(5 - 1 + 1)');
});

test('potencia, división entera y asignación múltiple', () => {
  const c = conv('local a = 2 ^ 3\nlocal b = 7 // 2\na, b = b, a').code;
  has(c, 'Math.pow(2, 3)');
  has(c, 'Math.floor(7 / 2)');
  has(c, 'var __t1 = b;');
  has(c, 'a = __t1;');
});

test('funciones como valor, métodos y callbacks', () => {
  const c = conv('local obj = {}\nfunction obj.go(a) return a end\nfunction obj:say() print(self) end\nlocal f = function(x) return x * 2 end').code;
  has(c, 'obj.go = function(a) {');
  has(c, 'obj.say = function() {');
  has(c, 'trace(obj);');
  has(c, 'var f = function(x) {');
});

test('palabras reservadas de Haxe como nombres', () => {
  const c = conv('local new = 1\nlocal default = new + 1').code;
  has(c, 'var new_ = 1;');
  has(c, 'var default_ = new_ + 1;');
});

test('comentarios se conservan', () => {
  const c = conv('-- hola\nlocal a = 1 -- fin\n--[[ bloque\nlargo ]]\nlocal b = 2').code;
  has(c, '// hola');
  has(c, 'var a = 1; // fin');
  has(c, '/* bloque\nlargo */');
});

test('cadenas con escapes', () => {
  const c = conv("local s = 'a\\nb\"c'").code;
  has(c, 'var s = "a\\nb\\"c";');
});

test('goto avisa', () => {
  const r = conv('::top::\ngoto top');
  warns(r, 'goto');
});

test('error de sintaxis con línea', () => {
  const r = L.convert('local a = 1\nif a then\n', { header: false });
  if (!r.error || r.line < 2) throw new Error('Debía dar error de sintaxis: ' + JSON.stringify(r));
});

console.log('Perfil Psych Engine');

test('getProperty / setProperty con ruta literal', () => {
  const c = conv("setProperty('boyfriend.x', getProperty('boyfriend.x') + 10)", { profile: 'psych' }).code;
  has(c, 'game.boyfriend.x = game.boyfriend.x + 10;');
});

test('sprites: make/add/propiedades por etiqueta', () => {
  const c = conv("makeLuaSprite('bg', 'stage/bg', 10, 20)\naddLuaSprite('bg', true)\nsetProperty('bg.alpha', 0.5)", { profile: 'psych' }).code;
  has(c, 'var bg;');
  has(c, 'bg = new FlxSprite(10, 20);');
  has(c, 'bg.loadGraphic(Paths.image("stage/bg"));');
  has(c, 'game.add(bg);');
  has(c, 'bg.alpha = 0.5;');
});

test('tween simple', () => {
  const r = conv("doTweenX('t', 'boyfriend', 100, 2, 'quadOut')", { profile: 'psych' });
  has(r.code, 'FlxTween.tween(game.boyfriend, {x: 100}, 2, {ease: FlxEase.quadOut});');
  warns(r, 'onTweenCompleted');
});

test('callback de nota recibe `note`', () => {
  const c = conv('function goodNoteHit(id, dir, nt, sus)\n  if sus then print(dir) end\nend', { profile: 'psych' }).code;
  has(c, 'function goodNoteHit(note) {');
  has(c, 'var dir = Math.abs(note.noteData);');
  has(c, 'var sus = note.isSustainNote;');
  hasNot(c, 'var nt');
});

test('nombres globales de Psych', () => {
  const c = conv('local w = screenWidth / 2', { profile: 'psych' }).code;
  has(c, 'FlxG.width / 2');
});

test('propiedad no literal avisa y no se rompe', () => {
  const r = conv('setProperty(name, 1)', { profile: 'psych' });
  warns(r, 'no literal');
  has(r.code, 'setProperty(name, 1);');
});

console.log('Perfil V-Slice');

test('callbacks reciben event', () => {
  const c = conv('function onUpdate(elapsed) x = elapsed end\nfunction onBeatHit() y = curBeat end', { profile: 'vslice' }).code;
  has(c, 'function onUpdate(event) {');
  has(c, 'var elapsed = event.elapsed;');
  has(c, 'function onBeatHit(event) {');
  has(c, 'var curBeat = event.beat;');
});

test('API de Psych avisa', () => {
  const r = conv("makeLuaSprite('a', 'b', 0, 0)", { profile: 'vslice' });
  warns(r, 'no existe en V-Slice');
});

console.log('Navegador');

test('los scripts cargan como en la página (sin require)', () => {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/lua2hx.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/profiles.js'), 'utf8'), sandbox);
  const r = vm.runInContext("Lua2Hx.convert('local a = 1', {profile: 'psych'}).code", sandbox);
  has(r, 'var a = 1;');
  const ids = vm.runInContext('Object.keys(Lua2Hx.profiles).join(",")', sandbox);
  has(ids, 'psych');
  has(ids, 'vslice');
});

console.log('\n' + passed + ' correctas, ' + failed + ' con fallo');
process.exit(failed ? 1 : 0);
