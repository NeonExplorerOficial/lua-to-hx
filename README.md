# lua-to-hx

Conversor de scripts **Lua → HScript (`.hx`)** para Friday Night Funkin'. Funciona en el navegador, sin instalar nada y sin subir tus archivos a ningún sitio.

> Estado: la dirección Lua → HScript está hecha. HScript → Lua está pendiente.

## Cómo usarlo

1. Abre `index.html` en el navegador (o publica el repo con GitHub Pages).
2. Elige el motor de destino, pega tu Lua o arrastra un archivo `.lua`.
3. Copia el resultado o descárgalo (`.hx`, o `.hxc` en V-Slice).
4. Revisa los **avisos** debajo del resultado: cada uno indica la línea de tu Lua y haciendo clic te lleva a ella.

## Motores

| Motor | Qué hace |
| --- | --- |
| **Psych Engine** | Sintaxis, librería estándar, callbacks y la API más común: `getProperty`/`setProperty` con texto literal, sprites (`makeLuaSprite`, `makeGraphic`, `addLuaSprite`, `removeLuaSprite`, `setObjectCamera`, `setScrollFactor`, `scaleObject`, `screenCenter`), `doTweenX/Y/Alpha/Angle/Zoom`, `playSound`, `getRandom*`, `debugPrint`. |
| **V-Slice** | Adapta los callbacks a módulos (`onUpdate(event)`, `onBeatHit(event)`, `onNoteHit(event)`...). La API de Lua de Psych no existe en V-Slice: esas llamadas se dejan y se avisa. |
| **Genérico** | Solo el lenguaje. Lo propio de cada motor se deja tal cual. |

El perfil de Psych es un punto de partida: lo que no reconoce se deja igual y se avisa, nunca se inventa.

## Qué convierte del lenguaje

- `local` → `var`; globales de Lua → `var` declaradas arriba del archivo.
- `if/elseif/else`, `while`, `repeat…until`, `for` numérico (incluido paso negativo o decimal), `for … in ipairs/pairs`.
- `and`/`or`/`not` con la verdad de Lua (solo `nil` y `false` son falsos). El idioma `c and a or b` pasa a `c ? a : b`.
- `..` → `+` (con `Std.string` cuando hace falta), `~=` → `!=`, `^` → `Math.pow`, `//` → `Math.floor(a / b)`, `#t` → `t.length`.
- Tablas: `{1, 2, 3}` → `[1, 2, 3]`, `{a = 1}` → `{a: 1}`, y los índices pasan de base 1 a base 0 en arrays.
- `table.insert/remove/concat/sort`, `string.sub/upper/lower/len`, `math.*`, `tostring`, `tonumber`, `print` → `trace`.
- Asignación múltiple (`a, b = b, a`), métodos `obj:fn()`, funciones anónimas, comentarios (línea y bloque).
- Nombres que Lua permite pero Haxe no (`new`, `default`, `class`...) se renombran con `_` al final.

## Limitaciones conocidas

El convertidor avisa en estos casos en vez de adivinar:

- Valores de retorno múltiples (`local a, b = f()`), `...` (varargs), `goto`, metatablas, `pcall`, `string.format`, patrones de Lua (`find`, `gsub`, `gmatch`).
- Índices dinámicos sobre variables cuyo tipo no se puede deducir (¿array o diccionario?).
- Funciones de motor con argumentos que no son texto literal (`setProperty(nombre, valor)`).
- Los tags de los tweens y timers (`onTweenCompleted`, `onTimerCompleted`) no se convierten.
- Comentarios dentro de expresiones o tablas multilínea se pierden (se avisa cuántos).

**Siempre prueba el script resultante en el juego.** No he podido ejecutar HScript aquí, así que la API de cada motor sale de la documentación y del conocimiento del motor, no de pruebas dentro del juego.

## Pruebas

```
node test/run.js
```

No hay dependencias. Las pruebas cubren el lenguaje, cada perfil y la carga de los scripts como en el navegador.

## Añadir funciones de un motor

Los perfiles están en `src/profiles.js`. Añadir una función es poner una entrada en `calls`:

```js
calls: {
  getRandomInt: function (c) {
    return 'FlxG.random.int(' + c.e(0) + ', ' + c.e(1) + ')';
  },
}
```

`c.e(i)` es el argumento `i` ya convertido, `c.str(i)` es su valor si es un texto literal, `c.warn(msg)` genera un aviso, y devolver `null` deja la llamada sin tocar. Si la llamada tiene que producir varias instrucciones, devuelve `{ stmts: ['...', '...'] }`.

## Estructura

```
index.html, style.css, app.js   interfaz web
src/lua2hx.js                   núcleo: lexer, parser de Lua y generador de HScript
src/profiles.js                 perfiles de motor (Psych Engine, V-Slice)
test/run.js                     pruebas
```
