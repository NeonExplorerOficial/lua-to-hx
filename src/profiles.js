/*
 * Perfiles de motor para lua2hx.
 *
 * Un perfil le dice al convertidor cómo traducir lo que es propio de cada motor
 * (callbacks, variables globales y funciones de la API de Lua del motor), no el
 * lenguaje en sí.
 *
 * Campos de un perfil:
 *   id, label, description, extension  -> datos para la interfaz
 *   names      { nombreLua: 'expresiónHScript' | {to, import} }   variables globales
 *   calls      { nombreFuncion: (c) => string | {stmts:[...]} | null }   funciones de API
 *   callbacks  { nombreCallback: (paramsLua, emitter) => {name?, params, prelude?} }
 *   boolNames  [nombres que se sabe que son booleanos]  -> condiciones más limpias
 *   imports    [líneas import que siempre se añaden]
 *
 * Añadir una función nueva es poner una entrada en `calls`. `c` ofrece:
 *   c.e(i) argumento i convertido · c.str(i) valor si es una cadena literal · c.has(i)
 *   c.isNil(i) · c.n (cantidad de argumentos) · c.warn(msg) · c.em (el generador)
 * Devolver `null` deja la llamada tal cual (y conviene avisar con c.warn).
 */
(function () {
  'use strict';
  var L = typeof module === 'object' && module.exports ? require('./lua2hx.js') : window.Lua2Hx;

  /* ====================================================================
   * Psych Engine
   * Los scripts HScript de Psych ven la instancia de PlayState como `game`
   * y tienen FlxG, FlxSprite, FlxTween, FlxEase, Paths, etc.
   * ==================================================================== */

  var PROP_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;

  // 'boyfriend.x' -> 'game.boyfriend.x'  (o la variable de un sprite creado con makeLuaSprite)
  function propPath(em, str) {
    if (!PROP_RE.test(str)) return null;
    var first = str.split(/[.\[]/)[0];
    var v = em.tagVar(first);
    if (v) return v + str.slice(first.length);
    return 'game.' + str;
  }

  function camRef(str) {
    var m = {
      camgame: 'game.camGame', game: 'game.camGame',
      camhud: 'game.camHUD', hud: 'game.camHUD',
      camother: 'game.camOther', other: 'game.camOther',
    };
    return m[String(str).toLowerCase()] || null;
  }

  // Objetivo de un tween/propiedad: etiqueta de sprite o ruta de propiedad.
  function targetRef(c, i) {
    var s = c.str(i);
    if (s === null) return null;
    return propPath(c.em, s);
  }

  function tween(prop) {
    return function (c) {
      var target = targetRef(c, 1);
      if (target === null) {
        c.warn('doTween' + prop[0].toUpperCase() + prop.slice(1) + ': el objeto no es una cadena literal, no se convierte');
        return null;
      }
      var ease = c.str(4);
      var easeTxt = 'FlxEase.' + (ease && /^[A-Za-z0-9]+$/.test(ease) ? ease : 'linear');
      c.warn('doTween: la etiqueta del tween no se conserva (onTweenCompleted no se convierte)');
      return {
        stmts: ['FlxTween.tween(' + target + ', {' + prop + ': ' + c.e(2) + '}, ' + c.e(3) + ', {ease: ' + easeTxt + '});'],
      };
    };
  }

  function spriteCall(fn) {
    return function (c) {
      var tag = c.str(0);
      if (tag === null) {
        c.warn('El tag no es una cadena literal: esta llamada no se puede convertir automáticamente');
        return null;
      }
      var v = c.em.tagVar(tag);
      if (!v) {
        c.warn('El sprite "' + tag + '" no se creó con makeLuaSprite en este script; se usa propiedad de game');
        v = 'game.' + tag;
      }
      return fn(c, v);
    };
  }

  L.registerProfile({
    id: 'psych',
    label: 'Psych Engine',
    description:
      'Scripts .lua de Psych Engine a HScript (.hx). Convierte callbacks, getProperty/setProperty con texto literal, sprites básicos (makeLuaSprite & cía.) y tweens simples. Lo que no reconoce se deja igual y se avisa.',
    extension: 'hx',
    imports: [],
    names: {
      screenWidth: 'FlxG.width',
      screenHeight: 'FlxG.height',
      curBeat: 'game.curBeat',
      curStep: 'game.curStep',
      curSection: 'game.curSection',
    },
    boolNames: ['downscroll', 'middlescroll', 'botPlay', 'inGameOver', 'isStoryMode', 'lowQuality', 'cpuControlled'],
    calls: {
      getProperty: function (c) {
        var s = c.str(0);
        var p = s === null ? null : propPath(c.em, s);
        if (p === null) {
          c.warn('getProperty con un texto no literal: no se convierte (usa game.propiedad a mano)');
          return null;
        }
        return p;
      },
      setProperty: function (c) {
        var s = c.str(0);
        var p = s === null ? null : propPath(c.em, s);
        if (p === null) {
          c.warn('setProperty con un texto no literal: no se convierte (usa game.propiedad = valor a mano)');
          return null;
        }
        return { stmts: [p + ' = ' + c.e(1) + ';'] };
      },

      playSound: function (c) {
        return { stmts: ['FlxG.sound.play(Paths.sound(' + c.e(0) + (c.has(1) ? '), ' + c.e(1) : '), 1') + ');'] };
      },
      getRandomInt: function (c) {
        return 'FlxG.random.int(' + c.e(0) + (c.has(1) ? ', ' + c.e(1) : '') + ')';
      },
      getRandomFloat: function (c) {
        return 'FlxG.random.float(' + c.e(0) + (c.has(1) ? ', ' + c.e(1) : '') + ')';
      },
      getRandomBool: function (c) {
        return 'FlxG.random.bool(' + (c.has(0) ? c.e(0) : '50') + ')';
      },
      debugPrint: function (c) {
        return 'trace(' + c.all() + ')';
      },

      makeLuaSprite: function (c) {
        var tag = c.str(0);
        if (tag === null) {
          c.warn('makeLuaSprite con tag no literal: no se convierte');
          return null;
        }
        var v = c.em.registerTag(tag);
        var stmts = [v + ' = new FlxSprite(' + (c.has(2) ? c.e(2) : '0') + ', ' + (c.has(3) ? c.e(3) : '0') + ');'];
        if (!c.isNil(1) && c.str(1) !== '') stmts.push(v + '.loadGraphic(Paths.image(' + c.e(1) + '));');
        return { stmts: stmts };
      },
      makeGraphic: spriteCall(function (c, v) {
        var col = c.str(3);
        var colTxt = col === null ? 'FlxColor.fromString("#" + ' + c.e(3) + ')' : 'FlxColor.fromString("#' + col.replace(/^(#|0x)/i, '') + '")';
        return { stmts: [v + '.makeGraphic(' + c.e(1) + ', ' + c.e(2) + ', ' + colTxt + ');'] };
      }),
      addLuaSprite: spriteCall(function (c, v) {
        var front = c.args[1];
        if (front && front.type === 'True') return { stmts: ['game.add(' + v + ');'] };
        if (front && front.type !== 'False' && front.type !== 'Nil') {
          return { stmts: ['if (' + c.em.truthy(front).s + ') game.add(' + v + '); else game.addBehindGF(' + v + ');'] };
        }
        return { stmts: ['game.addBehindGF(' + v + ');'] };
      }),
      removeLuaSprite: spriteCall(function (c, v) {
        return { stmts: ['game.remove(' + v + ', true);', v + '.destroy();'] };
      }),
      setObjectCamera: spriteCall(function (c, v) {
        var cam = c.str(1);
        var ref = cam === null ? 'game.camHUD' : camRef(cam);
        if (!ref) {
          c.warn('Cámara desconocida "' + cam + '": se usa game.camHUD');
          ref = 'game.camHUD';
        }
        return { stmts: [v + '.cameras = [' + ref + '];'] };
      }),
      setScrollFactor: spriteCall(function (c, v) {
        return { stmts: [v + '.scrollFactor.set(' + c.e(1) + ', ' + c.e(2) + ');'] };
      }),
      scaleObject: spriteCall(function (c, v) {
        var stmts = [v + '.scale.set(' + c.e(1) + ', ' + c.e(2) + ');'];
        var upd = c.args[3];
        if (!upd || upd.type !== 'False') stmts.push(v + '.updateHitbox();');
        return { stmts: stmts };
      }),
      updateHitbox: spriteCall(function (c, v) {
        return { stmts: [v + '.updateHitbox();'] };
      }),
      screenCenter: spriteCall(function (c, v) {
        var ax = c.str(1);
        if (ax === null || ax === 'xy') return { stmts: [v + '.screenCenter();'] };
        if (ax.toLowerCase() === 'x') return { stmts: [v + '.screenCenter(FlxAxes.X);'] };
        if (ax.toLowerCase() === 'y') return { stmts: [v + '.screenCenter(FlxAxes.Y);'] };
        return { stmts: [v + '.screenCenter();'] };
      }),

      doTweenX: tween('x'),
      doTweenY: tween('y'),
      doTweenAlpha: tween('alpha'),
      doTweenAngle: tween('angle'),
      doTweenZoom: tween('zoom'),
    },
    // Casi todos los callbacks de Psych se llaman igual en Lua y en HScript (onCreate,
    // onUpdate(elapsed), onBeatHit, onEvent...). Los de notas cambian: en HScript reciben
    // la nota (`note`) en vez de (id, direccion, tipo, esSustain).
    callbacks: {
      goodNoteHit: psychNote('goodNoteHit'),
      opponentNoteHit: psychNote('opponentNoteHit'),
      noteMiss: psychNote('noteMiss'),
    },
  });

  function psychNote(name) {
    return cb(name, ['note'], [
      function (o, used) { return used(o[0]) ? 'var ' + o[0] + ' = game.notes.members.indexOf(note);' : ''; },
      function (o, used) { return used(o[1]) ? 'var ' + o[1] + ' = Math.abs(note.noteData);' : ''; },
      function (o, used) { return used(o[2]) ? 'var ' + o[2] + ' = note.noteType;' : ''; },
      function (o, used) { return used(o[3]) ? 'var ' + o[3] + ' = note.isSustainNote;' : ''; },
    ]);
  }

  /* ====================================================================
   * Ayuda común para callbacks: renombra, cambia parámetros y declara al
   * principio las variables de Lua que ahora salen del evento/nota.
   * `used(nombre)` dice si el cuerpo de la función usa ese nombre.
   * ==================================================================== */
  function cb(name, params, prelude) {
    return function (orig, em, func) {
      var used = function (n) {
        return !!n && n !== '_' && em.usesName(func.body, n);
      };
      var pre = [];
      (prelude || []).forEach(function (f) {
        var r = typeof f === 'function' ? f(orig, used) : f;
        if (r) pre.push(r);
      });
      return { name: name, params: params, prelude: pre, declare: orig };
    };
  }

  /* ====================================================================
   * V-Slice (Friday Night Funkin' 0.5+)
   * Verificado en la documentación oficial de módulos: los callbacks reciben
   * un objeto `event` y los scripts de módulo usan la extensión .hxc.
   * V-Slice no usa la API de Lua de Psych, así que aquí solo se adaptan los
   * callbacks; las funciones de motor hay que portarlas a mano.
   * ==================================================================== */

  function vsliceNote(name) {
    return cb(name, ['event'], [
      function (o, used) { return used(o[1]) ? 'var ' + o[1] + ' = event.note.direction;' : ''; },
      function (o, used) { return used(o[0]) ? 'var ' + o[0] + ' = null; // TODO: en Psych era el índice de la nota; aquí usa event.note' : ''; },
      function (o, used) { return used(o[2]) ? 'var ' + o[2] + ' = null; // TODO: el tipo de nota de Psych no tiene equivalente directo' : ''; },
      function (o, used) { return used(o[3]) ? 'var ' + o[3] + ' = false; // TODO: ¿es nota larga? revisa event.note' : ''; },
    ]);
  }

  // Funciones de la API de Lua de Psych que no existen en V-Slice: se dejan igual pero se avisa.
  var psychOnly = Object.keys(L.profiles.psych.calls).concat([
    'makeAnimatedLuaSprite', 'makeLuaText', 'addLuaText', 'setTextString', 'setTextColor', 'removeLuaText',
    'addAnimationByPrefix', 'objectPlayAnimation', 'characterPlayAnim', 'runTimer', 'cancelTimer', 'cancelTween',
    'doTweenColor', 'noteTweenX', 'noteTweenY', 'noteTweenAngle', 'noteTweenAlpha', 'triggerEvent', 'cameraShake',
    'cameraFlash', 'cameraFade', 'setPropertyFromClass', 'getPropertyFromClass', 'setPropertyFromGroup',
    'getPropertyFromGroup', 'callOnLuas', 'setGraphicSize', 'getMouseX', 'getMouseY', 'keyboardJustPressed',
    'keyJustPressed', 'precacheImage', 'precacheSound', 'close', 'endSong', 'startVideo', 'getSongPosition',
  ]);
  var vsliceCalls = {};
  psychOnly.forEach(function (fn) {
    vsliceCalls[fn] = function (c) {
      c.warn(fn + '() es de la API de Lua de Psych y no existe en V-Slice: hay que portarla a mano');
      return null;
    };
  });

  L.registerProfile({
    id: 'vslice',
    label: 'V-Slice (módulos .hxc)',
    description:
      'Adapta los callbacks de Lua (onCreate, onUpdate, onBeatHit...) a los de módulos de V-Slice, que reciben un objeto "event". La API de Psych (getProperty, makeLuaSprite...) no existe en V-Slice, así que esas llamadas se dejan igual y se avisa.',
    extension: 'hxc',
    imports: [],
    names: {},
    boolNames: [],
    calls: vsliceCalls,
    callbacks: {
      onCreate: cb('onCreate', ['event']),
      onDestroy: cb('onDestroy', ['event']),
      onUpdate: cb('onUpdate', ['event'], [
        function (o, used) { return used(o[0]) ? 'var ' + o[0] + ' = event.elapsed;' : ''; },
      ]),
      onBeatHit: cb('onBeatHit', ['event'], [
        function (o, used) { return used('curBeat') ? 'var curBeat = event.beat;' : ''; },
      ]),
      onStepHit: cb('onStepHit', ['event'], [
        function (o, used) { return used('curStep') ? 'var curStep = event.step;' : ''; },
      ]),
      onSongStart: cb('onSongStart', ['event']),
      onEndSong: cb('onSongEnd', ['event']),
      onCountdownStarted: cb('onCountdownStart', ['event']),
      onCountdownTick: cb('onCountdownStep', ['event'], [
        function (o, used) { return used(o[0]) ? 'var ' + o[0] + ' = event.step;' : ''; },
      ]),
      goodNoteHit: vsliceNote('onNoteHit'),
      noteMiss: vsliceNote('onNoteMiss'),
    },
  });
})();
