/*
 * lua2hx — núcleo del convertidor de Lua a HScript (.hx) para FNF.
 *
 * Funciona igual en el navegador (expone `Lua2Hx` global) y en Node (module.exports).
 * Flujo: tokenize() -> Parser -> analyze() -> Emitter -> código HScript + avisos.
 *
 * Los perfiles de motor (Psych Engine, V-Slice...) viven en profiles.js y se
 * registran con Lua2Hx.registerProfile().
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Lua2Hx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ======================================================================
   * Utilidades
   * ==================================================================== */

  class LuaSyntaxError extends Error {
    constructor(msg, line) {
      super('Línea ' + line + ': ' + msg);
      this.name = 'LuaSyntaxError';
      this.line = line;
    }
  }

  const KEYWORDS = new Set(
    'and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' ')
  );

  // Palabras que Lua permite como identificador pero Haxe/HScript no.
  const RESERVED = new Set(
    'var new class switch case default catch try throw import package extends implements interface enum typedef static public private override inline final dynamic extern abstract macro untyped using cast this super null continue operator overload'.split(' ')
  );

  const CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

  function validIdent(s) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !RESERVED.has(s);
  }

  function hxString(s) {
    let o = '"';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === '\\') o += '\\\\';
      else if (ch === '"') o += '\\"';
      else if (ch === '\n') o += '\\n';
      else if (ch === '\r') o += '\\r';
      else if (ch === '\t') o += '\\t';
      else if (c < 0x20 || c === 0x7f) o += '\\x' + c.toString(16).padStart(2, '0');
      else o += ch;
    }
    return o + '"';
  }

  function fmtNum(raw) {
    let s = raw;
    if (/^0[xX]/.test(s)) return s;
    if (s[0] === '.') s = '0' + s;
    s = s.replace(/\.(?=[eE]|$)/, '.0');
    return s;
  }

  function isIntLiteral(e) {
    return e && e.type === 'Number' && /^\d+$/.test(e.value);
  }

  function walk(n, fn) {
    if (Array.isArray(n)) {
      for (const x of n) walk(x, fn);
      return;
    }
    if (n && typeof n === 'object' && n.type) {
      fn(n);
      for (const k in n) {
        if (k === 'leading' || k === 'trailing' || k === 'tail' || k === 'headTrailing') continue;
        const v = n[k];
        if (v && typeof v === 'object') walk(v, fn);
      }
    }
  }

  /* ======================================================================
   * Lexer
   * ==================================================================== */

  function tokenize(src) {
    const toks = [];
    const comments = [];
    const n = src.length;
    let i = 0;
    let line = 1;
    let pending = [];
    let last = null;

    if (src.charCodeAt(0) === 0xfeff) i = 1;
    if (src[i] === '#') while (i < n && src[i] !== '\n') i++; // línea shebang

    const fail = (m) => {
      throw new LuaSyntaxError(m, line);
    };
    const countNL = (s) => {
      let c = 0;
      for (let k = 0; k < s.length; k++) if (s[k] === '\n') c++;
      return c;
    };
    const longLevel = (at) => {
      let j = at + 1;
      let lvl = 0;
      while (src[j] === '=') {
        lvl++;
        j++;
      }
      return src[j] === '[' ? lvl : -1;
    };
    const readLong = (at, lvl) => {
      const close = ']' + '='.repeat(lvl) + ']';
      const from = at + lvl + 2;
      const end = src.indexOf(close, from);
      if (end < 0) fail('cadena o comentario largo sin cerrar');
      return { text: src.slice(from, end), end: end + close.length };
    };
    const push = (type, value, startLine, extra) => {
      const t = { type, value, line: startLine, endLine: line, leading: pending, trailing: null };
      if (extra) Object.assign(t, extra);
      pending = [];
      toks.push(t);
      last = t;
      return t;
    };

    const RE_NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
    const RE_NUM = /0[xX][0-9a-fA-F]*\.?[0-9a-fA-F]*(?:[pP][+-]?\d+)?|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y;
    const OPS3 = ['...'];
    const OPS2 = ['==', '~=', '<=', '>=', '//', '::', '..', '<<', '>>'];
    const OPS1 = '+-*/%^#&~|<>=(){}[];:,.';

    while (i < n) {
      const c = src[i];
      if (c === '\n') {
        line++;
        i++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
        i++;
        continue;
      }

      // comentarios
      if (c === '-' && src[i + 1] === '-') {
        const cmLine = line;
        let text;
        let block = false;
        if (src[i + 2] === '[') {
          const lvl = longLevel(i + 2);
          if (lvl >= 0) {
            const r = readLong(i + 2, lvl);
            text = r.text;
            block = true;
            line += countNL(src.slice(i, r.end));
            i = r.end;
          }
        }
        if (!block) {
          let j = i + 2;
          while (j < n && src[j] !== '\n') j++;
          text = src.slice(i + 2, j).replace(/\r$/, '');
          i = j;
        }
        const cm = { text, block, line: cmLine, used: false };
        comments.push(cm);
        if (last && last.endLine === cmLine) {
          if (!last.trailing) last.trailing = [];
          last.trailing.push(cm);
        } else {
          pending.push(cm);
        }
        continue;
      }

      const startLine = line;

      // cadenas con comillas
      if (c === '"' || c === "'") {
        let j = i + 1;
        let out = '';
        for (;;) {
          if (j >= n) fail('cadena sin cerrar');
          const ch = src[j];
          if (ch === c) {
            j++;
            break;
          }
          if (ch === '\n') fail('cadena sin cerrar');
          if (ch === '\\') {
            j++;
            const e = src[j];
            switch (e) {
              case 'n': out += '\n'; j++; break;
              case 't': out += '\t'; j++; break;
              case 'r': out += '\r'; j++; break;
              case 'a': out += '\x07'; j++; break;
              case 'b': out += '\b'; j++; break;
              case 'f': out += '\f'; j++; break;
              case 'v': out += '\v'; j++; break;
              case '\\': out += '\\'; j++; break;
              case '"': out += '"'; j++; break;
              case "'": out += "'"; j++; break;
              case '\n': out += '\n'; line++; j++; break;
              case 'x': {
                const h = src.slice(j + 1, j + 3);
                if (!/^[0-9a-fA-F]{2}$/.test(h)) fail('escape \\x inválido');
                out += String.fromCharCode(parseInt(h, 16));
                j += 3;
                break;
              }
              case 'z': {
                j++;
                while (j < n && /\s/.test(src[j])) {
                  if (src[j] === '\n') line++;
                  j++;
                }
                break;
              }
              case 'u': {
                const m = /^\{([0-9a-fA-F]+)\}/.exec(src.slice(j + 1));
                if (!m) fail('escape \\u inválido');
                out += String.fromCodePoint(parseInt(m[1], 16));
                j += 1 + m[0].length;
                break;
              }
              default: {
                if (e >= '0' && e <= '9') {
                  const m = /^\d{1,3}/.exec(src.slice(j));
                  out += String.fromCharCode(parseInt(m[0], 10));
                  j += m[0].length;
                } else {
                  fail('secuencia de escape inválida: \\' + e);
                }
              }
            }
            continue;
          }
          out += ch;
          j++;
        }
        i = j;
        push('string', out, startLine);
        continue;
      }

      // cadenas largas [[ ... ]]
      if (c === '[') {
        const lvl = longLevel(i);
        if (lvl >= 0) {
          const r = readLong(i, lvl);
          let text = r.text;
          if (text[0] === '\r' && text[1] === '\n') text = text.slice(2);
          else if (text[0] === '\n') text = text.slice(1);
          line += countNL(src.slice(i, r.end));
          i = r.end;
          push('string', text, startLine);
          continue;
        }
      }

      // números
      if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        RE_NUM.lastIndex = i;
        const m = RE_NUM.exec(src);
        i += m[0].length;
        push('number', m[0], startLine);
        continue;
      }

      // nombres / palabras clave
      if (/[A-Za-z_]/.test(c)) {
        RE_NAME.lastIndex = i;
        const m = RE_NAME.exec(src);
        i += m[0].length;
        push(KEYWORDS.has(m[0]) ? 'kw' : 'name', m[0], startLine);
        continue;
      }

      // operadores
      const s3 = src.substr(i, 3);
      if (OPS3.includes(s3)) {
        i += 3;
        push('op', s3, startLine);
        continue;
      }
      const s2 = src.substr(i, 2);
      if (OPS2.includes(s2)) {
        i += 2;
        push('op', s2, startLine);
        continue;
      }
      if (OPS1.includes(c)) {
        i++;
        push('op', c, startLine);
        continue;
      }
      fail("carácter inesperado '" + c + "'");
    }
    push('eof', '<eof>', line);
    return { toks, comments };
  }

  /* ======================================================================
   * Parser (gramática de Lua 5.x -> AST)
   * ==================================================================== */

  const BINPRI = {
    or: [1, 1], and: [2, 2],
    '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
    '|': [4, 4], '~': [5, 5], '&': [6, 6], '<<': [7, 7], '>>': [7, 7],
    '..': [9, 8], '+': [10, 10], '-': [10, 10],
    '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11],
    '^': [14, 13],
  };
  const UNARY_PRI = 12;

  class Parser {
    constructor(toks) {
      this.t = toks;
      this.p = 0;
      this.prev = null;
    }
    peek(o) {
      return this.t[Math.min(this.p + (o || 0), this.t.length - 1)];
    }
    next() {
      const k = this.t[this.p];
      if (this.p < this.t.length - 1) this.p++;
      this.prev = k;
      return k;
    }
    isOp(v) {
      const k = this.peek();
      return k.type === 'op' && k.value === v;
    }
    isKw(v) {
      const k = this.peek();
      return k.type === 'kw' && k.value === v;
    }
    acceptOp(v) {
      if (this.isOp(v)) return this.next();
      return null;
    }
    acceptKw(v) {
      if (this.isKw(v)) return this.next();
      return null;
    }
    err(msg, tok) {
      const k = tok || this.peek();
      const near = k.type === 'eof' ? 'el final del archivo' : "'" + k.value + "'";
      throw new LuaSyntaxError(msg + ' cerca de ' + near, k.line);
    }
    expectOp(v) {
      if (this.isOp(v)) return this.next();
      this.err("se esperaba '" + v + "'");
    }
    expectKw(v) {
      if (this.isKw(v)) return this.next();
      this.err("se esperaba '" + v + "'");
    }
    expectName() {
      const k = this.peek();
      if (k.type === 'name') return this.next().value;
      this.err('se esperaba un nombre');
    }

    parseChunk() {
      const body = this.block();
      if (this.peek().type !== 'eof') this.err("se esperaba el final del archivo (¿un 'end' de más?)");
      return { type: 'Chunk', body };
    }

    blockFollow() {
      const k = this.peek();
      if (k.type === 'eof') return true;
      return k.type === 'kw' && (k.value === 'else' || k.value === 'elseif' || k.value === 'end' || k.value === 'until');
    }

    block() {
      const stmts = [];
      for (;;) {
        if (this.blockFollow()) break;
        if (this.acceptOp(';')) continue;
        if (this.isKw('return')) {
          stmts.push(this.statement());
          break;
        }
        stmts.push(this.statement());
      }
      const term = this.peek();
      const tail = term.leading || [];
      term.leading = [];
      return { type: 'Block', stmts, tail };
    }

    statement() {
      const start = this.peek();
      const prevEnd = this.prev ? this.prev.endLine : 0;
      const firstLine = start.leading.length ? start.leading[0].line : start.line;
      let node;
      if (start.type === 'kw') {
        switch (start.value) {
          case 'if': node = this.ifStat(); break;
          case 'while': node = this.whileStat(); break;
          case 'do': {
            this.next();
            const body = this.block();
            this.expectKw('end');
            node = { type: 'Do', body };
            break;
          }
          case 'for': node = this.forStat(); break;
          case 'repeat': node = this.repeatStat(); break;
          case 'function': node = this.funcStat(); break;
          case 'local': node = this.localStat(); break;
          case 'return': node = this.returnStat(); break;
          case 'break': this.next(); node = { type: 'Break' }; break;
          case 'goto': {
            this.next();
            node = { type: 'Goto', label: this.expectName() };
            break;
          }
          default: node = this.exprStat();
        }
      } else if (start.type === 'op' && start.value === '::') {
        this.next();
        const name = this.expectName();
        this.expectOp('::');
        node = { type: 'Label', name };
      } else {
        node = this.exprStat();
      }
      node.line = start.line;
      node.leading = start.leading;
      node.trailing = this.prev ? this.prev.trailing : null;
      node.blankBefore = firstLine - prevEnd > 1;
      return node;
    }

    ifStat() {
      this.next();
      const clauses = [];
      let cond = this.expr();
      let t = this.expectKw('then');
      let body = this.block();
      clauses.push({ type: 'IfClause', cond, body, headTrailing: t.trailing });
      let orelse = null;
      for (;;) {
        if (this.acceptKw('elseif')) {
          cond = this.expr();
          t = this.expectKw('then');
          body = this.block();
          clauses.push({ type: 'IfClause', cond, body, headTrailing: t.trailing });
        } else if (this.isKw('else')) {
          const e = this.next();
          orelse = this.block();
          orelse.headTrailing = e.trailing;
          break;
        } else break;
      }
      this.expectKw('end');
      return { type: 'If', clauses, orelse };
    }

    whileStat() {
      this.next();
      const cond = this.expr();
      const d = this.expectKw('do');
      const body = this.block();
      this.expectKw('end');
      return { type: 'While', cond, body, headTrailing: d.trailing };
    }

    repeatStat() {
      const r = this.next();
      const body = this.block();
      this.expectKw('until');
      const cond = this.expr();
      return { type: 'Repeat', body, cond, headTrailing: r.trailing };
    }

    forStat() {
      this.next();
      const n1 = this.expectName();
      if (this.isOp('=')) {
        this.next();
        const start = this.expr();
        this.expectOp(',');
        const limit = this.expr();
        let step = null;
        if (this.acceptOp(',')) step = this.expr();
        const d = this.expectKw('do');
        const body = this.block();
        this.expectKw('end');
        return { type: 'NumFor', name: n1, start, limit, step, body, headTrailing: d.trailing };
      }
      const names = [n1];
      while (this.acceptOp(',')) names.push(this.expectName());
      this.expectKw('in');
      const exprs = this.exprList();
      const d = this.expectKw('do');
      const body = this.block();
      this.expectKw('end');
      return { type: 'GenFor', names, exprs, body, headTrailing: d.trailing };
    }

    funcStat() {
      this.next();
      const path = [this.expectName()];
      let method = null;
      while (this.acceptOp('.')) path.push(this.expectName());
      if (this.acceptOp(':')) method = this.expectName();
      const func = this.funcBody();
      return { type: 'FunctionStat', path, method, func };
    }

    localStat() {
      this.next();
      if (this.acceptKw('function')) {
        const name = this.expectName();
        const func = this.funcBody();
        return { type: 'LocalFunction', name, func };
      }
      const names = [];
      do {
        names.push(this.expectName());
        if (this.acceptOp('<')) {
          this.expectName(); // <const> / <close>
          this.expectOp('>');
        }
      } while (this.acceptOp(','));
      let exprs = [];
      if (this.acceptOp('=')) exprs = this.exprList();
      return { type: 'Local', names, exprs };
    }

    returnStat() {
      this.next();
      let exprs = [];
      if (!this.blockFollow() && !this.isOp(';')) exprs = this.exprList();
      this.acceptOp(';');
      return { type: 'Return', exprs };
    }

    exprStat() {
      const e = this.suffixedExpr();
      if (this.isOp('=') || this.isOp(',')) {
        const targets = [e];
        while (this.acceptOp(',')) targets.push(this.suffixedExpr());
        this.expectOp('=');
        const exprs = this.exprList();
        for (const t of targets) {
          if (t.type !== 'Name' && t.type !== 'Index') this.err('asignación inválida');
        }
        return { type: 'Assign', targets, exprs };
      }
      if (e.type === 'Call' || e.type === 'MethodCall') return { type: 'CallStat', expr: e };
      this.err('error de sintaxis');
    }

    funcBody() {
      this.expectOp('(');
      const params = [];
      let vararg = false;
      if (!this.isOp(')')) {
        do {
          if (this.isOp('...')) {
            this.next();
            vararg = true;
            break;
          }
          params.push(this.expectName());
        } while (this.acceptOp(','));
      }
      const close = this.expectOp(')');
      const body = this.block();
      this.expectKw('end');
      return { type: 'Function', params, vararg, body, headTrailing: close.trailing };
    }

    exprList() {
      const list = [this.expr()];
      while (this.acceptOp(',')) list.push(this.expr());
      return list;
    }

    expr(limit) {
      return this.subExpr(limit || 0);
    }

    subExpr(limit) {
      let left;
      const k = this.peek();
      if ((k.type === 'kw' && k.value === 'not') || (k.type === 'op' && (k.value === '-' || k.value === '#' || k.value === '~'))) {
        this.next();
        const arg = this.subExpr(UNARY_PRI);
        left = { type: 'Unop', op: k.value, arg };
      } else {
        left = this.simpleExpr();
      }
      for (;;) {
        const o = this.peek();
        const key = o.type === 'op' || (o.type === 'kw' && (o.value === 'and' || o.value === 'or')) ? o.value : null;
        const pri = key && BINPRI[key];
        if (!pri || pri[0] <= limit) break;
        this.next();
        const right = this.subExpr(pri[1]);
        left = { type: 'Binop', op: key, left, right };
      }
      return left;
    }

    simpleExpr() {
      const k = this.peek();
      switch (k.type) {
        case 'number': this.next(); return { type: 'Number', value: k.value };
        case 'string': this.next(); return { type: 'String', value: k.value };
        case 'kw':
          if (k.value === 'nil') { this.next(); return { type: 'Nil' }; }
          if (k.value === 'true') { this.next(); return { type: 'True' }; }
          if (k.value === 'false') { this.next(); return { type: 'False' }; }
          if (k.value === 'function') { this.next(); return this.funcBody(); }
          break;
        case 'op':
          if (k.value === '...') { this.next(); return { type: 'Vararg' }; }
          if (k.value === '{') return this.tableCons();
          break;
      }
      return this.suffixedExpr();
    }

    primaryExpr() {
      const k = this.peek();
      if (k.type === 'name') {
        this.next();
        return { type: 'Name', name: k.value };
      }
      if (k.type === 'op' && k.value === '(') {
        this.next();
        const e = this.expr();
        this.expectOp(')');
        return { type: 'Paren', expr: e };
      }
      this.err('se esperaba una expresión');
    }

    suffixedExpr() {
      let e = this.primaryExpr();
      for (;;) {
        const k = this.peek();
        if (k.type === 'op') {
          if (k.value === '.') {
            this.next();
            const name = this.expectName();
            e = { type: 'Index', obj: e, key: { type: 'String', value: name }, dot: true };
            continue;
          }
          if (k.value === '[') {
            this.next();
            const key = this.expr();
            this.expectOp(']');
            e = { type: 'Index', obj: e, key, dot: false };
            continue;
          }
          if (k.value === ':') {
            this.next();
            const name = this.expectName();
            const args = this.callArgs();
            e = { type: 'MethodCall', obj: e, name, args };
            continue;
          }
          if (k.value === '(' || k.value === '{') {
            e = { type: 'Call', callee: e, args: this.callArgs() };
            continue;
          }
        } else if (k.type === 'string') {
          e = { type: 'Call', callee: e, args: this.callArgs() };
          continue;
        }
        return e;
      }
    }

    callArgs() {
      const k = this.peek();
      if (k.type === 'string') {
        this.next();
        return [{ type: 'String', value: k.value }];
      }
      if (k.type === 'op' && k.value === '{') return [this.tableCons()];
      this.expectOp('(');
      let args = [];
      if (!this.isOp(')')) args = this.exprList();
      this.expectOp(')');
      return args;
    }

    tableCons() {
      this.expectOp('{');
      const fields = [];
      while (!this.isOp('}')) {
        const k = this.peek();
        if (k.type === 'name' && this.peek(1).type === 'op' && this.peek(1).value === '=') {
          this.next();
          this.next();
          fields.push({ type: 'Field', kind: 'name', key: k.value, value: this.expr() });
        } else if (k.type === 'op' && k.value === '[') {
          this.next();
          const key = this.expr();
          this.expectOp(']');
          this.expectOp('=');
          fields.push({ type: 'Field', kind: 'expr', key, value: this.expr() });
        } else {
          fields.push({ type: 'Field', kind: 'pos', value: this.expr() });
        }
        if (!this.acceptOp(',') && !this.acceptOp(';')) break;
      }
      this.expectOp('}');
      return { type: 'Table', fields };
    }
  }

  /* ======================================================================
   * Análisis previo: ¿qué variables se usan como array y cuáles como objeto?
   * ==================================================================== */

  function analyze(chunk) {
    const arrays = new Set();
    const objects = new Set();
    const funcs = new Set();
    const nm = (e) => (e && e.type === 'Name' ? e.name : null);
    walk(chunk, (n) => {
      switch (n.type) {
        case 'Call': {
          const c = n.callee;
          if (c.type === 'Index' && c.dot && c.obj.type === 'Name' && c.obj.name === 'table' && n.args[0]) {
            const a = nm(n.args[0]);
            if (a) arrays.add(a);
          }
          if (c.type === 'Name' && c.name === 'ipairs' && n.args[0]) {
            const a = nm(n.args[0]);
            if (a) arrays.add(a);
          }
          break;
        }
        case 'Unop':
          if (n.op === '#') {
            const a = nm(n.arg);
            if (a) arrays.add(a);
          }
          break;
        case 'Index': {
          const a = nm(n.obj);
          if (!a) break;
          if (n.dot || n.key.type === 'String') objects.add(a);
          else if (n.key.type === 'Number') arrays.add(a);
          break;
        }
        case 'FunctionStat':
          if (!n.method && n.path.length === 1) funcs.add(n.path[0]);
          break;
      }
    });
    return { arrays, objects, funcs };
  }

  /* ======================================================================
   * Funciones estándar de Lua -> HScript
   * ==================================================================== */

  const CONSTS = {
    'math.pi': 'Math.PI',
    'math.huge': 'Math.POSITIVE_INFINITY',
    'math.maxinteger': '2147483647',
    'math.mininteger': '-2147483648',
  };

  // Ajusta un índice de Lua (base 1) a base 0.
  function minus1(em, e) {
    if (e.type === 'Number' && /^\d+$/.test(e.value)) return String(Number(e.value) - 1);
    if (e.type === 'Binop' && e.op === '+' && e.right.type === 'Number' && e.right.value === '1') return em.expr(e.left, 0);
    if (e.type === 'Binop' && e.op === '-' && e.right.type === 'Number' && /^\d+$/.test(e.right.value)) {
      return em.expr(e.left, 60) + ' - ' + (Number(e.right.value) + 1);
    }
    return em.expr(e, 60) + ' - 1';
  }

  const LIB = {
    print: (c) => 'trace(' + c.all() + ')',
    tostring: (c) => 'Std.string(' + c.e(0) + ')',
    tonumber: (c) => 'Std.parseFloat(' + c.e(0) + ')',
    error: (c) => ({ stmts: ['throw ' + c.e(0) + ';'] }),
    assert: (c) => ({ stmts: ['if (!(' + c.e(0) + ')) throw ' + (c.has(1) ? c.e(1) : '"assertion failed"') + ';'] }),

    'math.floor': (c) => 'Math.floor(' + c.e(0) + ')',
    'math.ceil': (c) => 'Math.ceil(' + c.e(0) + ')',
    'math.abs': (c) => 'Math.abs(' + c.e(0) + ')',
    'math.sqrt': (c) => 'Math.sqrt(' + c.e(0) + ')',
    'math.sin': (c) => 'Math.sin(' + c.e(0) + ')',
    'math.cos': (c) => 'Math.cos(' + c.e(0) + ')',
    'math.tan': (c) => 'Math.tan(' + c.e(0) + ')',
    'math.asin': (c) => 'Math.asin(' + c.e(0) + ')',
    'math.acos': (c) => 'Math.acos(' + c.e(0) + ')',
    'math.atan': (c) => (c.has(1) ? 'Math.atan2(' + c.all() + ')' : 'Math.atan(' + c.e(0) + ')'),
    'math.atan2': (c) => 'Math.atan2(' + c.all() + ')',
    'math.exp': (c) => 'Math.exp(' + c.e(0) + ')',
    'math.log': (c) => (c.has(1) ? '(Math.log(' + c.e(0) + ') / Math.log(' + c.e(1) + '))' : 'Math.log(' + c.e(0) + ')'),
    'math.pow': (c) => 'Math.pow(' + c.all() + ')',
    'math.min': (c) => (c.n === 2 ? 'Math.min(' + c.all() + ')' : null),
    'math.max': (c) => (c.n === 2 ? 'Math.max(' + c.all() + ')' : null),
    'math.fmod': (c) => '(' + c.e(0) + ' % ' + c.e(1) + ')',
    'math.rad': (c) => '(' + c.em.expr(c.args[0], 70) + ' * Math.PI / 180)',
    'math.deg': (c) => '(' + c.em.expr(c.args[0], 70) + ' * 180 / Math.PI)',
    'math.random': (c) => {
      if (c.n === 0) return 'Math.random()';
      if (c.n === 1) return '(Std.random(' + c.e(0) + ') + 1)';
      return '(' + c.em.expr(c.args[0], 60) + ' + Std.random(' + c.em.expr(c.args[1], 60) + ' - ' + c.em.expr(c.args[0], 61) + ' + 1))';
    },
    'math.randomseed': () => ({ stmts: [] }),

    'string.upper': (c) => c.em.expr(c.args[0], 100) + '.toUpperCase()',
    'string.lower': (c) => c.em.expr(c.args[0], 100) + '.toLowerCase()',
    'string.len': (c) => c.em.expr(c.args[0], 100) + '.length',
    'string.sub': (c) => strSub(c.em, c.args[0], c.args.slice(1)),
    'string.rep': (c) => { c.warn('string.rep no tiene equivalente directo; revísalo a mano'); return null; },
    'string.format': (c) => { c.warn('string.format no existe en HScript; arma el texto con + o StringTools'); return null; },
    'string.find': (c) => { c.warn('string.find usa patrones de Lua; no se pueden convertir automáticamente'); return null; },
    'string.gsub': (c) => { c.warn('string.gsub usa patrones de Lua; usa StringTools.replace u otra alternativa'); return null; },

    'table.insert': (c) => {
      const t = c.em.expr(c.args[0], 100);
      if (c.n === 2) return { stmts: [t + '.push(' + c.e(1) + ');'] };
      return { stmts: [t + '.insert(' + minus1(c.em, c.args[1]) + ', ' + c.e(2) + ');'] };
    },
    'table.remove': (c) => {
      const t = c.em.expr(c.args[0], 100);
      if (c.n === 1) return t + '.pop()';
      return t + '.splice(' + minus1(c.em, c.args[1]) + ', 1)[0]';
    },
    'table.concat': (c) => c.em.expr(c.args[0], 100) + '.join(' + (c.has(1) ? c.e(1) : '""') + ')',
    'table.sort': (c) => {
      const t = c.em.expr(c.args[0], 100);
      if (!c.has(1)) return { stmts: [t + '.sort(function(a, b) { return a < b ? -1 : (a > b ? 1 : 0); });'] };
      let fn = c.em.expr(c.args[1], 0);
      if (c.args[1].type === 'Function') fn = '(' + fn + ')';
      return { stmts: [t + '.sort(function(__a, __b) { return ' + fn + '(__a, __b) ? -1 : 1; });'] };
    },
    'table.unpack': (c) => { c.warn('table.unpack no existe en HScript'); return null; },
    unpack: (c) => { c.warn('unpack no existe en HScript'); return null; },

    'os.time': () => '(Date.now().getTime() / 1000)',
    'os.clock': () => 'haxe.Timer.stamp()',
    require: (c) => { c.warn('require() no existe en HScript; importa la clase con import o copia el código'); return null; },
    setmetatable: (c) => { c.warn('Las metatablas no existen en HScript; hay que reescribirlas a mano'); return null; },
    getmetatable: (c) => { c.warn('Las metatablas no existen en HScript; hay que reescribirlas a mano'); return null; },
    pcall: (c) => { c.warn('pcall no se convierte automáticamente; usa try/catch'); return null; },
    type: (c) => { c.warn('type() no tiene equivalente directo; usa Std.isOfType o Type.typeof'); return null; },
    pairs: (c) => { c.warn('pairs() fuera de un for no se puede convertir'); return null; },
    ipairs: (c) => { c.warn('ipairs() fuera de un for no se puede convertir'); return null; },
    select: (c) => { c.warn('select() no existe en HScript'); return null; },
  };

  function strSub(em, objE, rest) {
    const o = em.expr(objE, 100);
    if (rest.length === 1) return o + '.substring(' + minus1(em, rest[0]) + ')';
    if (rest.length >= 2) return o + '.substring(' + minus1(em, rest[0]) + ', ' + em.expr(rest[1], 0) + ')';
    return o;
  }

  /* ======================================================================
   * Perfiles de motor
   * ==================================================================== */

  const profiles = {
    generic: {
      id: 'generic',
      label: 'Genérico (solo el lenguaje)',
      description: 'Convierte solo la sintaxis y la librería estándar de Lua. Las funciones propias de un motor se dejan tal cual.',
      extension: 'hx',
      names: {},
      calls: {},
      callbacks: {},
      boolNames: [],
    },
  };

  function registerProfile(p) {
    profiles[p.id] = Object.assign(
      { names: {}, calls: {}, callbacks: {}, boolNames: [], extension: 'hx', imports: [] },
      p
    );
  }

  /* ======================================================================
   * Generador de HScript
   * ==================================================================== */

  const P_PRIMARY = 100;
  const P_UNARY = 80;
  const BIN_PREC = {
    '*': 70, '/': 70, '%': 70,
    '+': 60, '-': 60,
    '<<': 50, '>>': 50,
    '&': 40, '|': 40, '^': 40,
    '==': 30, '!=': 30, '<': 30, '<=': 30, '>': 30, '>=': 30,
  };
  const BOOL_NAME_RE = /^(is|has|can|should|use|allow)[A-Z_]/;

  function sameRef(a, b) {
    if (a.type !== b.type) return false;
    if (a.type === 'Name') return a.name === b.name;
    if (a.type === 'Index') {
      if (a.dot !== b.dot) return false;
      if (a.dot) return a.key.value === b.key.value && sameRef(a.obj, b.obj);
      return a.key.type === 'Number' && b.key.type === 'Number' && a.key.value === b.key.value && sameRef(a.obj, b.obj);
    }
    return false;
  }

  function isPure(e) {
    switch (e.type) {
      case 'Name': case 'Nil': case 'True': case 'False': case 'Number': case 'String': return true;
      case 'Paren': return isPure(e.expr);
      case 'Index': return isPure(e.obj) && (e.dot || isPure(e.key));
      default: return false;
    }
  }

  function trailText(list) {
    if (!list || !list.length) return '';
    let out = '';
    for (const c of list) {
      c.used = true;
      out += c.block ? ' /*' + c.text.replace(/\*\//g, '* /') + '*/' : ' //' + c.text;
    }
    return out;
  }

  class Emitter {
    constructor(opts, profile, analysis) {
      this.o = opts;
      this.p = profile;
      this.a = analysis;
      this.lines = [];
      this.level = 0;
      this.scopes = [new Set()];
      this.globals = new Set();
      this.tags = new Map();
      this.warnings = [];
      this.selfStack = [];
      this.tmp = 0;
      this.funcDepth = 0;
      this.curLine = 0;
      this.usesTruthy = false;
      this.imports = new Set();
      this.boolSet = new Set(profile.boolNames || []);
      this.warnSeen = new Set();
    }

    /* ---- infraestructura ---- */
    ind(l) {
      return this.o.indent.repeat(l === undefined ? this.level : l);
    }
    line(s) {
      this.lines.push(this.ind() + s);
    }
    warn(msg) {
      const key = this.curLine + '|' + msg;
      if (this.warnSeen.has(key)) return;
      this.warnSeen.add(key);
      this.warnings.push({ line: this.curLine, msg });
    }
    pushScope() { this.scopes.push(new Set()); }
    popScope() { this.scopes.pop(); }
    declare(n) { this.scopes[this.scopes.length - 1].add(n); }
    isLocal(n) {
      for (let k = this.scopes.length - 1; k >= 0; k--) if (this.scopes[k].has(n)) return true;
      return false;
    }
    indented(fn) {
      this.level++;
      this.pushScope();
      fn();
      this.popScope();
      this.level--;
    }
    id(n) {
      return RESERVED.has(n) ? n + '_' : n;
    }
    newTmp() {
      return '__t' + ++this.tmp;
    }
    kindOf(name) {
      const a = this.a.arrays.has(name);
      const o = this.a.objects.has(name);
      if (o && !a) return 'object';
      if (a && !o) return 'array';
      if (a && o) return 'mixed';
      return null;
    }
    registerTag(tag) {
      if (this.tags.has(tag)) return this.tags.get(tag);
      let v = tag.replace(/[^A-Za-z0-9_]/g, '_');
      if (/^[0-9]/.test(v) || v === '') v = 'spr_' + v;
      v = this.id(v);
      this.tags.set(tag, v);
      this.globals.add(v);
      return v;
    }
    tagVar(tag) {
      return this.tags.get(tag);
    }
    addImport(s) {
      this.imports.add(s);
    }

    comments(list) {
      if (!list) return;
      for (const c of list) {
        c.used = true;
        if (c.block) this.line('/*' + c.text.replace(/\*\//g, '* /') + '*/');
        else this.line('//' + c.text);
      }
    }
    addTrailing(list) {
      const t = trailText(list);
      if (!t) return;
      if (this.lines.length) this.lines[this.lines.length - 1] += t;
    }

    /* ---- bloques y sentencias ---- */
    emitBlock(block) {
      block.stmts.forEach((s, idx) => {
        if (s.blankBefore && idx > 0 && this.lines.length && this.lines[this.lines.length - 1] !== '') this.lines.push('');
        this.comments(s.leading);
        this.curLine = s.line;
        this.stmt(s);
        this.addTrailing(s.trailing);
      });
      this.comments(block.tail);
    }

    stmt(s) {
      switch (s.type) {
        case 'Local': return this.localStat(s);
        case 'Assign': return this.assignStat(s);
        case 'CallStat': return this.callStat(s);
        case 'Do':
          this.line('{');
          this.indented(() => this.emitBlock(s.body));
          this.line('}');
          return;
        case 'While':
          this.line('while (' + this.truthy(s.cond).s + ') {' + trailText(s.headTrailing));
          this.indented(() => this.emitBlock(s.body));
          this.line('}');
          return;
        case 'Repeat':
          this.line('while (true) {' + trailText(s.headTrailing));
          this.indented(() => {
            this.emitBlock(s.body);
            this.line('if (' + this.truthy(s.cond).s + ') break;');
          });
          this.line('}');
          return;
        case 'If': return this.ifStat(s);
        case 'NumFor': return this.numFor(s);
        case 'GenFor': return this.genFor(s);
        case 'FunctionStat': return this.funcStat(s);
        case 'LocalFunction':
          this.declare(s.name);
          this.line(this.funcText(s.func, this.id(s.name)));
          return;
        case 'Return': return this.returnStat(s);
        case 'Break': this.line('break;'); return;
        case 'Goto':
          this.warn('goto no existe en HScript (etiqueta "' + s.label + '")');
          this.line('// TODO: goto ' + s.label + ' (no soportado en HScript)');
          return;
        case 'Label':
          this.warn('Las etiquetas (::' + s.name + '::) no existen en HScript');
          this.line('// TODO: etiqueta ::' + s.name + ':: (no soportada en HScript)');
          return;
        default:
          throw new Error('Sentencia desconocida: ' + s.type);
      }
    }

    refsAny(e, names) {
      let found = false;
      walk(e, (n) => {
        if (n.type === 'Name' && names.has(n.name)) found = true;
      });
      return found;
    }

    exprFor(e, nameHint) {
      if (e.type === 'Table' && e.fields.length === 0 && nameHint) {
        const k = this.kindOf(nameHint);
        return k === 'object' ? '{}' : '[]';
      }
      return this.expr(e, 0);
    }

    localStat(s) {
      const { names, exprs } = s;
      if (!exprs.length) {
        for (const n of names) {
          this.declare(n);
          this.line('var ' + this.id(n) + ';');
        }
        return;
      }
      if (names.length === 1) {
        const v = this.exprFor(exprs[0], names[0]);
        this.declare(names[0]);
        this.line('var ' + this.id(names[0]) + ' = ' + v + ';');
        return;
      }
      const nameSet = new Set(names);
      const lastMulti = exprs.length < names.length && /^(Call|MethodCall|Vararg)$/.test(exprs[exprs.length - 1].type);
      if (lastMulti) this.warn('Valores de retorno múltiples no soportados: solo se usa el primero');
      if (exprs.length >= names.length && !exprs.some((e) => this.refsAny(e, nameSet))) {
        names.forEach((n, i) => {
          this.line('var ' + this.id(n) + ' = ' + this.exprFor(exprs[i], n) + ';');
        });
        names.forEach((n) => this.declare(n));
        return;
      }
      if (exprs.length < names.length) {
        names.forEach((n, i) => {
          this.line('var ' + this.id(n) + (i < exprs.length ? ' = ' + this.exprFor(exprs[i], n) : '') + ';');
        });
        names.forEach((n) => this.declare(n));
        return;
      }
      const temps = exprs.map((e) => {
        const t = this.newTmp();
        this.line('var ' + t + ' = ' + this.expr(e, 0) + ';');
        return t;
      });
      names.forEach((n, i) => this.line('var ' + this.id(n) + ' = ' + temps[i] + ';'));
      names.forEach((n) => this.declare(n));
    }

    nameWrite(name) {
      if (!this.isLocal(name) && !(name === 'self' && this.selfStack.length)) {
        if (!this.a.funcs.has(name)) this.globals.add(name);
      }
      return this.nameRef(name);
    }

    // Escribe en un destino (Name o Index). op es '=' o '+=', etc.
    writeTarget(t, value, op) {
      op = op || '=';
      if (t.type === 'Name') {
        this.line(this.nameWrite(t.name) + ' ' + op + ' ' + value + ';');
        return;
      }
      const parts = this.indexParts(t, true);
      if (parts.kind === 'dot') this.line(parts.o + '.' + parts.key + ' ' + op + ' ' + value + ';');
      else if (parts.kind === 'bracket') this.line(parts.o + '[' + parts.key + '] ' + op + ' ' + value + ';');
      else if (op === '=') this.line('Reflect.setField(' + parts.o + ', ' + parts.key + ', ' + value + ');');
      else {
        const bin = op.slice(0, -1);
        this.line('Reflect.setField(' + parts.o + ', ' + parts.key + ', Reflect.field(' + parts.o + ', ' + parts.key + ') ' + bin + ' ' + value + ');');
      }
    }

    assignStat(s) {
      const { targets, exprs } = s;
      if (targets.length === 1 && exprs.length === 1) {
        const t = targets[0];
        const e = exprs[0];
        if (e.type === 'Binop' && ['+', '-', '*', '/'].includes(e.op) && sameRef(t, e.left)) {
          this.writeTarget(t, this.expr(e.right, 0), e.op + '=');
          return;
        }
        const hint = t.type === 'Name' ? t.name : null;
        this.writeTarget(t, this.exprFor(e, hint), '=');
        return;
      }
      const lastMulti = exprs.length < targets.length && /^(Call|MethodCall|Vararg)$/.test(exprs[exprs.length - 1].type);
      if (lastMulti) this.warn('Valores de retorno múltiples no soportados: solo se usa el primero');
      // asignación múltiple: evaluar todo primero en temporales (permite intercambios a, b = b, a)
      this.line('{');
      this.level++;
      const temps = exprs.map((e) => {
        const t = this.newTmp();
        this.line('var ' + t + ' = ' + this.expr(e, 0) + ';');
        return t;
      });
      targets.forEach((t, i) => {
        this.writeTarget(t, i < temps.length ? temps[i] : 'null', '=');
      });
      this.level--;
      this.line('}');
    }

    callStat(s) {
      const e = s.expr;
      if (e.type === 'Call') {
        const r = this.callRaw(e, true);
        if (typeof r === 'string') this.line(r + ';');
        else r.stmts.forEach((x) => this.line(x));
      } else {
        this.line(this.methodCall(e) + ';');
      }
    }

    ifStat(s) {
      s.clauses.forEach((c, idx) => {
        this.line((idx === 0 ? 'if' : '} else if') + ' (' + this.truthy(c.cond).s + ') {' + trailText(c.headTrailing));
        this.indented(() => this.emitBlock(c.body));
      });
      if (s.orelse) {
        this.line('} else {' + trailText(s.orelse.headTrailing));
        this.indented(() => this.emitBlock(s.orelse));
      }
      this.line('}');
    }

    numFor(s) {
      const v = this.id(s.name);
      const stepLit = s.step ? this.stepValue(s.step) : 1;
      const fast = stepLit === 1 && !/[.eE]/.test(s.start.type === 'Number' ? s.start.value : '0') && !(s.limit.type === 'Number' && /[.eE]/.test(s.limit.value));
      if (fast) {
        const a = this.expr(s.start, 0);
        let b;
        if (isIntLiteral(s.limit)) b = String(Number(s.limit.value) + 1);
        else b = '(' + this.expr(s.limit, 0) + ' + 1)';
        this.line('for (' + v + ' in ' + a + '...' + b + ') {' + trailText(s.headTrailing));
        this.indented(() => {
          this.declare(s.name);
          this.emitBlock(s.body);
        });
        this.line('}');
        return;
      }
      // caso general: paso distinto de 1, negativo o decimal
      const i = this.newTmp();
      const lim = this.newTmp();
      const st = this.newTmp();
      this.line('{');
      this.level++;
      this.line('var ' + i + ' = ' + this.expr(s.start, 0) + ';');
      this.line('var ' + lim + ' = ' + this.expr(s.limit, 0) + ';');
      this.line('var ' + st + ' = ' + (s.step ? this.expr(s.step, 0) : '1') + ';');
      let cond;
      if (stepLit !== null && stepLit > 0) cond = i + ' <= ' + lim;
      else if (stepLit !== null && stepLit < 0) cond = i + ' >= ' + lim;
      else cond = '(' + st + ' > 0 ? ' + i + ' <= ' + lim + ' : ' + i + ' >= ' + lim + ')';
      this.line('while (' + cond + ') {' + trailText(s.headTrailing));
      this.indented(() => {
        this.line('var ' + v + ' = ' + i + ';');
        this.declare(s.name);
        this.emitBlock(s.body);
        this.line(i + ' += ' + st + ';');
      });
      this.line('}');
      this.level--;
      this.line('}');
    }

    stepValue(e) {
      if (e.type === 'Number') return Number(e.value);
      if (e.type === 'Unop' && e.op === '-' && e.arg.type === 'Number') return -Number(e.arg.value);
      return null;
    }

    usesName(block, name) {
      let found = false;
      walk(block, (n) => {
        if (n.type === 'Name' && n.name === name) found = true;
      });
      return found;
    }

    genFor(s) {
      const { names, exprs, body } = s;
      const it = exprs.length === 1 && exprs[0].type === 'Call' && exprs[0].callee.type === 'Name' ? exprs[0] : null;
      const fn = it ? it.callee.name : null;
      const tr = trailText(s.headTrailing);

      if (it && (fn === 'ipairs' || fn === 'pairs') && it.args.length === 1 && !this.isLocal(fn)) {
        const tE = it.args[0];
        const tName = tE.type === 'Name' ? tE.name : null;
        let kind = fn === 'ipairs' ? 'array' : tName ? this.kindOf(tName) : null;
        if (fn === 'pairs' && !kind) {
          this.warn('pairs(): no se sabe si es array u objeto; se trata como objeto (campos con nombre)');
          kind = 'object';
        }
        if (kind === 'mixed') kind = 'object';
        const kN = names[0];
        const vN = names[1];
        const ts = this.expr(tE, 100);
        if (kind === 'array') {
          const usesIdx = kN !== '_' && this.usesName(body, kN);
          if (!usesIdx && vN) {
            this.line('for (' + this.id(vN) + ' in ' + ts + ') {' + tr);
            this.indented(() => {
              this.declare(vN);
              this.emitBlock(body);
            });
            this.line('}');
            return;
          }
          let src = ts;
          let pre = false;
          if (!isPure(tE)) {
            src = this.newTmp();
            this.line('{');
            this.level++;
            this.line('var ' + src + ' = ' + ts + ';');
            pre = true;
          }
          const ix = this.newTmp();
          this.line('for (' + ix + ' in 0...' + src + '.length) {' + tr);
          this.indented(() => {
            if (usesIdx) {
              this.line('var ' + this.id(kN) + ' = ' + ix + ' + 1;');
              this.declare(kN);
            }
            if (vN && vN !== '_') {
              this.line('var ' + this.id(vN) + ' = ' + src + '[' + ix + '];');
              this.declare(vN);
            }
            this.emitBlock(body);
          });
          this.line('}');
          if (pre) {
            this.level--;
            this.line('}');
          }
          return;
        }
        // objeto
        let src = ts;
        let pre = false;
        if (!isPure(tE)) {
          src = this.newTmp();
          this.line('{');
          this.level++;
          this.line('var ' + src + ' = ' + ts + ';');
          pre = true;
        }
        this.line('for (' + this.id(kN) + ' in Reflect.fields(' + src + ')) {' + tr);
        this.indented(() => {
          this.declare(kN);
          if (vN && vN !== '_') {
            this.line('var ' + this.id(vN) + ' = Reflect.field(' + src + ', ' + this.id(kN) + ');');
            this.declare(vN);
          }
          this.emitBlock(body);
        });
        this.line('}');
        if (pre) {
          this.level--;
          this.line('}');
        }
        return;
      }

      // iterador genérico desconocido
      this.warn('for con iterador genérico (' + (fn || 'expresión') + '): revisa el resultado a mano');
      const e = this.expr(exprs[0], 0);
      if (names.length === 1) this.line('for (' + this.id(names[0]) + ' in ' + e + ') { // TODO: revisar iterador' + tr);
      else this.line('for (' + this.id(names[0]) + ' => ' + this.id(names[1]) + ' in ' + e + ') { // TODO: revisar iterador' + tr);
      this.indented(() => {
        names.forEach((n) => this.declare(n));
        this.emitBlock(body);
      });
      this.line('}');
    }

    returnStat(s) {
      if (!s.exprs.length) this.line('return;');
      else if (s.exprs.length === 1) this.line('return ' + this.expr(s.exprs[0], 0) + ';');
      else {
        this.warn('return con varios valores: se devuelve un array');
        this.line('return [' + s.exprs.map((e) => this.expr(e, 0)).join(', ') + ']; // TODO: devolvía varios valores');
      }
    }

    funcStat(s) {
      const { path, method, func } = s;
      if (path.length === 1 && !method) {
        const name = path[0];
        const cb = this.funcDepth === 0 && this.p.callbacks && this.p.callbacks[name];
        if (cb) {
          const t = cb(func.params.slice(), this, func);
          this.line(this.funcText(func, this.id(t.name || name), t));
        } else {
          this.line(this.funcText(func, this.id(name)));
        }
        return;
      }
      const base = path.map((p, i) => (i === 0 ? this.nameRef(p) : p)).join('.');
      if (method) {
        this.warn('function ' + base + ':' + method + '(): "self" se reemplaza por "' + base + '"');
        this.selfStack.push(base);
        this.line(base + '.' + method + ' = ' + this.funcText(func, null) + ';');
        this.selfStack.pop();
      } else {
        this.line(base + ' = ' + this.funcText(func, null) + ';');
      }
    }

    funcText(f, name, tweak) {
      this.pushScope();
      const params = tweak && tweak.params ? tweak.params : f.params;
      if (!tweak) f.params.forEach((p) => this.declare(p));
      else params.forEach((p) => this.declare(p));
      if (tweak && tweak.declare) tweak.declare.forEach((p) => this.declare(p));
      if (f.vararg) this.warn('Parámetros variables (...) no soportados en HScript');
      const saved = this.lines;
      this.lines = [];
      this.level++;
      this.funcDepth++;
      if (tweak && tweak.prelude) tweak.prelude.forEach((l) => String(l).split('\n').forEach((x) => this.line(x)));
      this.emitBlock(f.body);
      this.funcDepth--;
      this.level--;
      const body = this.lines;
      this.lines = saved;
      this.popScope();
      const head = 'function' + (name ? ' ' + name : '') + '(' + params.map((p) => this.id(p)).join(', ') + ') {' + trailText(f.headTrailing);
      return head + '\n' + (body.length ? body.join('\n') + '\n' : '') + this.ind() + '}';
    }

    /* ---- expresiones ---- */
    expr(e, min) {
      const r = this.ex(e);
      return r.p < (min || 0) ? '(' + r.s + ')' : r.s;
    }

    nameRef(name) {
      if (name === 'self' && this.selfStack.length) return this.selfStack[this.selfStack.length - 1];
      if (!this.isLocal(name) && this.p.names && Object.prototype.hasOwnProperty.call(this.p.names, name)) {
        const m = this.p.names[name];
        if (typeof m === 'object') {
          if (m.import) this.addImport(m.import);
          return m.to;
        }
        return m;
      }
      return this.id(name);
    }

    ex(e) {
      const P = (s) => ({ s, p: P_PRIMARY });
      switch (e.type) {
        case 'Nil': return P('null');
        case 'True': return P('true');
        case 'False': return P('false');
        case 'Number': return P(fmtNum(e.value));
        case 'String': return P(hxString(e.value));
        case 'Vararg':
          this.warn('... (varargs) no soportado en HScript');
          return P('__args');
        case 'Function': return P(this.funcText(e, null));
        case 'Name': return P(this.nameRef(e.name));
        case 'Paren': {
          const r = this.ex(e.expr);
          return r.p >= P_PRIMARY ? r : P('(' + r.s + ')');
        }
        case 'Index': return P(this.indexRead(e));
        case 'Call': return P(this.callRaw(e, false));
        case 'MethodCall': return P(this.methodCall(e));
        case 'Table': return P(this.table(e));
        case 'Binop': return this.binop(e);
        case 'Unop': return this.unop(e);
        default:
          throw new Error('Expresión desconocida: ' + e.type);
      }
    }

    binop(e) {
      const op = e.op;
      if (op === 'and' || op === 'or') return this.logic(e);
      if (op === '..') return this.concat(e);
      if (op === '^') return { s: 'Math.pow(' + this.expr(e.left, 0) + ', ' + this.expr(e.right, 0) + ')', p: P_PRIMARY };
      if (op === '//') return { s: 'Math.floor(' + this.expr(e.left, 70) + ' / ' + this.expr(e.right, 71) + ')', p: P_PRIMARY };
      const map = { '~=': '!=', '~': '^' };
      const hop = map[op] || op;
      const p = BIN_PREC[hop];
      return { s: this.expr(e.left, p) + ' ' + hop + ' ' + this.expr(e.right, p + 1), p };
    }

    unop(e) {
      switch (e.op) {
        case '-': {
          const a = this.expr(e.arg, P_UNARY);
          return { s: '-' + (a[0] === '-' ? '(' + a + ')' : a), p: P_UNARY };
        }
        case '~': return { s: '~' + this.expr(e.arg, P_UNARY), p: P_UNARY };
        case '#': return { s: this.expr(e.arg, P_PRIMARY) + '.length', p: P_PRIMARY };
        case 'not': return this.notTruthy(e.arg);
        default: throw new Error('Operador unario desconocido: ' + e.op);
      }
    }

    isStringy(e) {
      if (e.type === 'String') return true;
      if (e.type === 'Paren') return this.isStringy(e.expr);
      if (e.type === 'Binop' && e.op === '..') return true;
      if (e.type === 'Call' && e.callee.type === 'Name' && e.callee.name === 'tostring') return true;
      return false;
    }

    concat(e) {
      const parts = [];
      const flat = (x) => {
        if (x.type === 'Binop' && x.op === '..') {
          flat(x.left);
          flat(x.right);
        } else parts.push(x);
      };
      flat(e);
      const out = parts.map((p, i) => {
        if (i === 0 && !this.isStringy(p)) return 'Std.string(' + this.expr(p, 0) + ')';
        return this.expr(p, 61);
      });
      return { s: out.join(' + '), p: 60 };
    }

    /* ---- verdad/falsedad al estilo Lua ---- */
    boolish(e) {
      switch (e.type) {
        case 'True': case 'False': return true;
        case 'Paren': return this.boolish(e.expr);
        case 'Binop':
          if (e.op === '==' || e.op === '~=' || e.op === '<' || e.op === '<=' || e.op === '>' || e.op === '>=') return true;
          if (e.op === 'and' || e.op === 'or') return this.boolish(e.left) && this.boolish(e.right);
          return false;
        case 'Unop': return e.op === 'not';
        case 'Name':
          return !this.o.strictTruthiness || BOOL_NAME_RE.test(e.name) || this.boolSet.has(e.name);
        case 'Index':
          if (!this.o.strictTruthiness) return true;
          return e.dot && (BOOL_NAME_RE.test(e.key.value) || this.boolSet.has(e.key.value));
        case 'Call': case 'MethodCall':
          return !this.o.strictTruthiness;
        default: return false;
      }
    }

    // Devuelve la expresión como condición booleana de Haxe.
    truthy(e) {
      if (e.type === 'Paren') return this.truthy(e.expr);
      if (e.type === 'Binop' && (e.op === 'and' || e.op === 'or')) {
        const a = this.truthy(e.left);
        const b = this.truthy(e.right);
        const op = e.op === 'and' ? '&&' : '||';
        const p = e.op === 'and' ? 20 : 10;
        const wrap = (r, min) => (r.p < min ? '(' + r.s + ')' : r.s);
        return { s: wrap(a, p) + ' ' + op + ' ' + wrap(b, p), p };
      }
      if (e.type === 'Unop' && e.op === 'not') return this.notTruthy(e.arg);
      if (e.type === 'Number' || e.type === 'String' || e.type === 'Table' || e.type === 'Function') return { s: 'true', p: P_PRIMARY };
      if (e.type === 'Nil') return { s: 'false', p: P_PRIMARY };
      if (this.boolish(e)) return this.ex(e);
      if (isPure(e)) {
        const s = this.expr(e, 31);
        return { s: s + ' != null && ' + s + ' != false', p: 20 };
      }
      this.usesTruthy = true;
      return { s: '__truthy(' + this.expr(e, 0) + ')', p: P_PRIMARY };
    }

    notTruthy(arg) {
      if (arg.type === 'Paren') return this.notTruthy(arg.expr);
      if (arg.type === 'Unop' && arg.op === 'not') return this.truthy(arg.arg);
      if (arg.type === 'Binop' && (arg.op === 'and' || arg.op === 'or')) {
        return { s: '!(' + this.truthy(arg).s + ')', p: P_UNARY };
      }
      if (this.boolish(arg)) {
        const r = this.ex(arg);
        return { s: '!' + (r.p < P_UNARY ? '(' + r.s + ')' : r.s), p: P_UNARY };
      }
      if (isPure(arg)) {
        const s = this.expr(arg, 31);
        return { s: s + ' == null || ' + s + ' == false', p: 10 };
      }
      this.usesTruthy = true;
      return { s: '!__truthy(' + this.expr(arg, 0) + ')', p: P_UNARY };
    }

    // and/or en contexto de valor (Lua devuelve operandos, no booleanos).
    logic(e) {
      const { op, left, right } = e;
      if (op === 'or' && left.type === 'Binop' && left.op === 'and') {
        // idioma a and b or c  ->  condición ? b : c
        const c = this.truthy(left.left);
        return { s: '(' + c.s + ' ? ' + this.expr(left.right, 0) + ' : ' + this.expr(right, 0) + ')', p: P_PRIMARY };
      }
      if (this.boolish(left) && this.boolish(right)) return this.truthy(e);
      if (!isPure(left)) this.warn('and/or con una llamada como primer operando: se evalúa dos veces en el resultado');
      const c = this.truthy(left);
      if (op === 'or') return { s: '(' + c.s + ' ? ' + this.expr(left, 0) + ' : ' + this.expr(right, 0) + ')', p: P_PRIMARY };
      return { s: '(' + c.s + ' ? ' + this.expr(right, 0) + ' : ' + this.expr(left, 0) + ')', p: P_PRIMARY };
    }

    /* ---- índices y tablas ---- */
    // kind: 'dot' | 'bracket' | 'reflect'
    indexParts(e, forWrite) {
      const o = e.obj.type === 'Function' ? '(' + this.expr(e.obj, 0) + ')' : this.expr(e.obj, P_PRIMARY);
      if (e.dot) return { kind: 'dot', o, key: e.key.value };
      const k = e.key;
      if (k.type === 'String') {
        if (validIdent(k.value)) return { kind: 'dot', o, key: k.value };
        return { kind: 'reflect', o, key: hxString(k.value) };
      }
      const kind = e.obj.type === 'Name' ? this.kindOf(e.obj.name) : null;
      if (k.type === 'Number') {
        if (/^\d+$/.test(k.value)) return { kind: 'bracket', o, key: String(Number(k.value) - 1) };
        return { kind: 'bracket', o, key: this.expr(k, 0) };
      }
      if (kind === 'object') return { kind: 'reflect', o, key: this.expr(k, 0) };
      if (kind === 'array' || kind === 'mixed') return { kind: 'bracket', o, key: minus1(this, k) };
      this.warn('Índice dinámico en "' + this.exprText(e.obj) + '": si es un array de Lua recuerda que empieza en 1 y en HScript en 0');
      return { kind: 'bracket', o, key: this.expr(k, 0) };
    }

    exprText(e) {
      try {
        return this.expr(e, 0);
      } catch (err) {
        return '?';
      }
    }

    indexRead(e) {
      if (e.dot && e.obj.type === 'Name' && !this.isLocal(e.obj.name)) {
        const k = e.obj.name + '.' + e.key.value;
        if (CONSTS[k]) return CONSTS[k];
      }
      const p = this.indexParts(e, false);
      if (p.kind === 'dot') return p.o + '.' + p.key;
      if (p.kind === 'bracket') return p.o + '[' + p.key + ']';
      return 'Reflect.field(' + p.o + ', ' + p.key + ')';
    }

    wrapList(open, items, close) {
      const inline = open + items.join(', ') + close;
      if (inline.length <= 90 && inline.indexOf('\n') < 0) return inline;
      const pad = this.ind(this.level + 1);
      return open + '\n' + items.map((i) => pad + i).join(',\n') + '\n' + this.ind() + close;
    }

    table(e) {
      const f = e.fields;
      if (!f.length) return '[]';
      this.level++;
      let out;
      try {
        if (f.every((x) => x.kind === 'pos')) {
          out = this.wrapList('[', f.map((x) => this.expr(x.value, 0)), ']');
        } else {
          const items = [];
          let n = 0;
          let mixed = false;
          for (const x of f) {
            let key;
            if (x.kind === 'pos') {
              mixed = true;
              key = '_' + ++n;
            } else if (x.kind === 'name') key = validIdent(x.key) ? x.key : hxString(x.key);
            else if (x.key.type === 'String') key = validIdent(x.key.value) ? x.key.value : hxString(x.key.value);
            else if (x.key.type === 'Number') {
              mixed = true;
              key = '_' + x.key.value;
            } else {
              this.warn('Clave de tabla calculada no soportada en un literal; se omite el campo');
              continue;
            }
            items.push(key + ': ' + this.expr(x.value, 0));
          }
          if (mixed) this.warn('Tabla mixta (posiciones y nombres): las posiciones se guardan como _1, _2...');
          out = this.wrapList('{', items, '}');
        }
      } finally {
        this.level--;
      }
      return out;
    }

    /* ---- llamadas ---- */
    libKey(callee) {
      if (callee.type === 'Name' && !this.isLocal(callee.name)) return callee.name;
      if (callee.type === 'Index' && callee.dot && callee.obj.type === 'Name' && !this.isLocal(callee.obj.name)) {
        return callee.obj.name + '.' + callee.key.value;
      }
      return null;
    }

    ctx(args, isStmt) {
      const self = this;
      return {
        args,
        n: args.length,
        isStmt,
        em: self,
        e: (i) => (args[i] ? self.expr(args[i], 0) : 'null'),
        has: (i) => i < args.length,
        str: (i) => (args[i] && args[i].type === 'String' ? args[i].value : null),
        num: (i) => (args[i] && args[i].type === 'Number' ? Number(args[i].value) : null),
        isNil: (i) => !args[i] || args[i].type === 'Nil',
        all: (from) => args.slice(from || 0).map((a) => self.expr(a, 0)).join(', '),
        warn: (m) => self.warn(m),
      };
    }

    callRaw(e, isStmt) {
      const key = this.libKey(e.callee);
      if (key) {
        const rule = (this.p.calls && this.p.calls[key]) || LIB[key];
        if (rule) {
          const r = rule(this.ctx(e.args, isStmt));
          if (typeof r === 'string') return r;
          if (r && r.stmts) {
            if (isStmt) return r;
            this.warn(key + '() solo se puede convertir como instrucción, no dentro de una expresión');
          }
        }
      }
      const callee = e.callee.type === 'Function' ? '(' + this.expr(e.callee, 0) + ')' : this.expr(e.callee, P_PRIMARY);
      const args = e.args.map((a) => this.expr(a, 0)).join(', ');
      return callee + '(' + args + ')';
    }

    methodCall(e) {
      const o = this.expr(e.obj, P_PRIMARY);
      const args = e.args;
      switch (e.name) {
        case 'upper': return o + '.toUpperCase()';
        case 'lower': return o + '.toLowerCase()';
        case 'len': return o + '.length';
        case 'sub': return strSub(this, e.obj, args);
        case 'rep': case 'format': case 'find': case 'gsub': case 'gmatch': case 'match': case 'byte':
          this.warn(':' + e.name + '() de strings no tiene equivalente directo en HScript');
          break;
      }
      return o + '.' + e.name + '(' + args.map((a) => this.expr(a, 0)).join(', ') + ')';
    }

    /* ---- salida final ---- */
    run(ast) {
      this.emitBlock(ast.body);
      const out = [];
      if (this.o.header) {
        out.push('// Convertido de Lua a HScript con lua-to-hx (perfil: ' + this.p.label + ')');
        out.push('// Revisa los avisos y prueba el script en el juego: algunas partes pueden necesitar ajustes.');
        out.push('');
      }
      const imports = new Set([...(this.p.imports || []), ...this.imports]);
      if (imports.size) {
        imports.forEach((i) => out.push(i));
        out.push('');
      }
      const hoist = [...this.globals].filter((n) => !this.a.funcs.has(n) && !(this.p.names && n in this.p.names));
      if (hoist.length) {
        out.push('// Variables globales de Lua (en HScript hay que declararlas)');
        hoist.forEach((n) => out.push('var ' + this.id(n) + ';'));
        out.push('');
      }
      if (this.usesTruthy) {
        out.push('// Verdad al estilo Lua: solo null y false son falsos');
        out.push('function __truthy(v) {');
        out.push(this.o.indent + 'return v != null && v != false;');
        out.push('}');
        out.push('');
      }
      return out.concat(this.lines).join('\n').replace(/\n+$/, '') + '\n';
    }
  }

  /* ======================================================================
   * API pública
   * ==================================================================== */

  function convert(src, options) {
    const opts = Object.assign(
      { profile: 'generic', indent: '    ', header: true, strictTruthiness: true },
      options || {}
    );
    const profile = profiles[opts.profile] || profiles.generic;
    let toks;
    let ast;
    let comments;
    try {
      const r = tokenize(String(src));
      toks = r.toks;
      comments = r.comments;
      ast = new Parser(toks).parseChunk();
    } catch (err) {
      if (err instanceof LuaSyntaxError) return { code: '', warnings: [], error: err.message, line: err.line };
      throw err;
    }
    const em = new Emitter(opts, profile, analyze(ast));
    const code = em.run(ast);
    const lost = comments.filter((c) => !c.used).length;
    if (lost) em.warnings.push({ line: 0, msg: lost + ' comentario(s) dentro de expresiones o tablas no se conservaron' });
    return { code, warnings: em.warnings, error: null, line: 0 };
  }

  return { convert, tokenize, Parser, analyze, registerProfile, profiles, LuaSyntaxError, helpers: { hxString, validIdent, minus1 } };
});
