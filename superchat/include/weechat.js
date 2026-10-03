// superchat - Developed by acidvegas in JavaScript (https://github.com/acidvegas)
// superchat/include/weechat.js

(function () {
	'use strict';

	const SC = window.SuperChat;
	const BACKLOG = 500;

	// --- State ---
	let ws = null;
	let opts = null;
	let stage = 'idle';
	let ready = false;
	let reconnectTimer = null;
	let handshakeTimer = null;
	let reqSeq = 0;
	let callbacks = {};
	let queue = Promise.resolve();
	let lastActiveName = null;
	let pendingQuery = null;
	let completion = null;

	const loginEl   = document.getElementById('login');
	const appEl     = document.getElementById('app');
	const errorEl   = document.getElementById('login-error');
	const totpEl    = document.getElementById('login-wc-totp');

	// ============================================================
	//  Binary protocol decoder
	// ============================================================
	const utf8 = new TextDecoder('utf-8');

	function Reader(buf) {
		this.view = new DataView(buf);
		this.bytes = new Uint8Array(buf);
		this.pos = 0;
	}

	Reader.prototype.done = function () { return this.pos >= this.bytes.length; };
	Reader.prototype.chr = function () { return this.view.getInt8(this.pos++); };
	Reader.prototype.int = function () { const v = this.view.getInt32(this.pos); this.pos += 4; return v; };
	Reader.prototype.ascii = function (len) {
		let s = '';
		for (let i = 0; i < len; i++) s += String.fromCharCode(this.bytes[this.pos + i]);
		this.pos += len;
		return s;
	};
	Reader.prototype.type = function () { return this.ascii(3); };
	Reader.prototype.str = function () {
		const len = this.int();
		if (len < 0) return null;
		const s = utf8.decode(this.bytes.subarray(this.pos, this.pos + len));
		this.pos += len;
		return s;
	};
	Reader.prototype.lon = function () { return parseInt(this.ascii(this.bytes[this.pos++]), 10); };
	Reader.prototype.ptr = function () { return '0x' + this.ascii(this.bytes[this.pos++]); };
	Reader.prototype.htb = function () {
		const kt = this.type(), vt = this.type(), count = this.int();
		const h = {};
		for (let i = 0; i < count; i++) {
			const k = this.obj(kt);
			h[k] = this.obj(vt);
		}
		return h;
	};
	Reader.prototype.hda = function () {
		const hpath = this.str();
		const keysStr = this.str();
		const count = this.int();
		const items = [];
		if (!hpath || !keysStr) return items;
		const depth = hpath.split('/').length;
		const keys = keysStr.split(',').map(function (k) { const c = k.indexOf(':'); return [k.substring(0, c), k.substring(c + 1)]; });
		for (let i = 0; i < count; i++) {
			const item = { __path: [] };
			for (let p = 0; p < depth; p++) item.__path.push(this.ptr());
			for (let k = 0; k < keys.length; k++) item[keys[k][0]] = this.obj(keys[k][1]);
			items.push(item);
		}
		return items;
	};
	Reader.prototype.inf = function () { return { name: this.str(), value: this.str() }; };
	Reader.prototype.inl = function () {
		const name = this.str(), count = this.int();
		const items = [];
		for (let i = 0; i < count; i++) {
			const n = this.int(), item = {};
			for (let j = 0; j < n; j++) {
				const key = this.str();
				item[key] = this.obj(this.type());
			}
			items.push(item);
		}
		return { name: name, items: items };
	};
	Reader.prototype.arr = function () {
		const t = this.type(), count = this.int();
		const a = [];
		for (let i = 0; i < count; i++) a.push(this.obj(t));
		return a;
	};
	Reader.prototype.obj = function (t) {
		switch (t) {
		case 'chr': return this.chr();
		case 'int': return this.int();
		case 'lon': return this.lon();
		case 'str': case 'buf': return this.str();
		case 'ptr': return this.ptr();
		case 'tim': return this.lon();
		case 'htb': return this.htb();
		case 'hda': return this.hda();
		case 'inf': return this.inf();
		case 'inl': return this.inl();
		case 'arr': return this.arr();
		}
		throw new Error('Unknown object type: ' + t);
	};

	function inflate(bytes) {
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
		return new Response(stream).arrayBuffer();
	}

	function decodeMessage(buf) {
		const head = new DataView(buf);
		const body = buf.slice(5);
		const comp = head.getUint8(4);
		if (comp > 1) throw new Error('Unsupported compression: ' + comp);
		const data = comp === 1 ? inflate(body) : Promise.resolve(body);
		return data.then(function (data) {
			const r = new Reader(data);
			const msg = { id: r.str(), objects: [] };
			while (!r.done()) msg.objects.push(r.obj(r.type()));
			return msg;
		});
	}

	// ============================================================
	//  WeeChat color codes → HTML
	// ============================================================
	const TERM16 = [
		'#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
		'#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'
	];

	// WeeChat basic colors (index 0-16) → terminal color number
	const BASIC = [null, 0, 8, 1, 9, 2, 10, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];
	const NAMED = {
		'default': null, black: 0, darkgray: 8, red: 1, lightred: 9, green: 2, lightgreen: 10, brown: 3,
		yellow: 11, blue: 4, lightblue: 12, magenta: 5, lightmagenta: 13, cyan: 6, lightcyan: 14, gray: 7, white: 15
	};

	// Default values of weechat.color.* options, indexed like WeeChat's t_gui_color_enum
	const OPTION_COLORS = [
		236, null, null, 'brown', 'yellow', 'magenta', 'white', 'lightgreen', 'lightred', 'lightmagenta',
		24, 'white', 'brown', 'white', 'lightcyan', 'white', 'cyan', null, null, null,
		null, null, null, null, null, null, null, 'cyan', 22, 'yellow',
		'magenta', 'yellow', 'cyan', 180, 'red', 240, null, null, 242, null,
		'green', 'green', 'yellow', 'cyan', 'blue', 'red', 'green'
	];

	function termColor(n) {
		if (n === null || n === undefined || isNaN(n)) return null;
		if (n < 16) return TERM16[n];
		if (n < 232) {
			const levels = [0, 95, 135, 175, 215, 255];
			const c = n - 16;
			return 'rgb(' + levels[Math.floor(c / 36)] + ',' + levels[Math.floor(c / 6) % 6] + ',' + levels[c % 6] + ')';
		}
		if (n < 256) {
			const g = 8 + (n - 232) * 10;
			return 'rgb(' + g + ',' + g + ',' + g + ')';
		}
		return null;
	}

	function optionColor(n) {
		const v = OPTION_COLORS[n];
		return termColor(typeof v === 'string' ? NAMED[v] : v);
	}

	const ATTR_CHARS = { '*': 'bold', '!': 'reverse', '/': 'italic', '_': 'underline' };
	const ATTR_CODES = { '\x01': 'bold', '\x02': 'reverse', '\x03': 'italic', '\x04': 'underline' };

	// Parse a WeeChat string into [{text, fg, bg, bold, italic, underline, reverse}]
	function parseColors(s) {
		const segs = [];
		const st = { fg: null, bg: null, bold: false, italic: false, underline: false, reverse: false };
		let text = '';
		let i = 0;

		function flush() {
			if (text) segs.push(Object.assign({ text: text }, st));
			text = '';
		}

		function isDigit(c) { return c >= '0' && c <= '9'; }

		// Reads "[@][attrs]NN" or "@[attrs]NNNNN" (fg) / "[@]NN" (bg); returns the CSS color
		function readColor(withAttrs) {
			let ext = false;
			if (s[i] === '@') { ext = true; i++; }
			if (withAttrs) {
				let keep = false;
				const set = [];
				while (i < s.length && (ATTR_CHARS[s[i]] || s[i] === '|' || s[i] === '%' || s[i] === '.')) {
					if (s[i] === '|') keep = true;
					else if (ATTR_CHARS[s[i]]) set.push(ATTR_CHARS[s[i]]);
					i++;
				}
				if (!keep) st.bold = st.italic = st.underline = st.reverse = false;
				set.forEach(function (a) { st[a] = true; });
			}
			const len = ext ? 5 : 2;
			const num = parseInt(s.substr(i, len), 10);
			i += len;
			return ext ? termColor(num) : termColor(BASIC[num]);
		}

		while (i < s.length) {
			const c = s[i];
			if (c === '\x19') {
				flush();
				i++;
				const t = s[i];
				if (t === 'F') { i++; st.fg = readColor(true); }
				else if (t === 'B') { i++; st.bg = readColor(false); }
				else if (t === '*') {
					i++;
					st.fg = readColor(true);
					if (s[i] === ',' || s[i] === '~') { i++; st.bg = readColor(false); }
				}
				else if (t === '@') { i += 6; }
				else if (t === 'E') { i++; }
				else if (t === 'b') { i += 2; }
				else if (t === '\x1C') { i++; st.fg = st.bg = null; }
				else if (isDigit(t) && isDigit(s[i + 1])) { st.fg = optionColor(parseInt(s.substr(i, 2), 10)); i += 2; }
			} else if (c === '\x1A' || c === '\x1B') {
				flush();
				const a = ATTR_CODES[s[i + 1]];
				if (a) st[a] = (c === '\x1A');
				i += 2;
			} else if (c === '\x1C') {
				flush();
				st.fg = st.bg = null;
				st.bold = st.italic = st.underline = st.reverse = false;
				i++;
			} else {
				text += c;
				i++;
			}
		}
		flush();
		return segs;
	}

	function segsText(segs) {
		return segs.map(function (g) { return g.text; }).join('');
	}

	function segsHtml(segs) {
		return segs.map(function (g) {
			const css = [];
			let fg = g.fg, bg = g.bg;
			if (g.reverse) { fg = bg || '#000'; bg = g.fg || '#c0c0c0'; }
			if (fg)          css.push('color:' + fg);
			if (bg)          css.push('background-color:' + bg);
			if (g.bold)      css.push('font-weight:bold');
			if (g.italic)    css.push('font-style:italic');
			if (g.underline) css.push('text-decoration:underline');
			const t = SC.esc(g.text);
			return css.length ? '<span style="' + css.join(';') + '">' + t + '</span>' : t;
		}).join('');
	}

	function stripColors(s) {
		return segsText(parseColors(s || ''));
	}

	// Nick column built from a colored WeeChat prefix, truncated like SuperChat's chatNick()
	function nickCol(prefix, highlight) {
		let segs = parseColors(prefix || '');
		const full = segsText(segs);
		if (full.length > SC.NICK_MAX) {
			let left = SC.NICK_MAX;
			const cut = [];
			for (let k = 0; k < segs.length && left > 0; k++) {
				cut.push(Object.assign({}, segs[k], { text: segs[k].text.substring(0, left) }));
				left -= segs[k].text.length;
			}
			cut.push({ text: '..' });
			segs = cut;
		}
		if (highlight) {
			segs = [{ text: segsText(segs), fg: '#ffff00', bg: termColor(124) }];
		}
		return '<span class="nick-col" title="' + SC.esc(full) + '">' + segsHtml(segs) + '</span> <span class="sep">│</span> ';
	}

	function lineHtml(ld) {
		return nickCol(ld.prefix, ld.highlight) + SC.linkify(segsHtml(parseColors(ld.message || '')));
	}

	// ============================================================
	//  Connection
	// ============================================================
	function send(cmd) {
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(cmd + '\n');
	}

	function request(cmd, cb) {
		const id = 'r' + (++reqSeq);
		callbacks[id] = cb;
		send('(' + id + ') ' + cmd);
	}

	function loginError(text) {
		errorEl.textContent = text;
		errorEl.classList.toggle('hidden', !text);
	}

	function localNotice(text, color) {
		const core = coreWindow();
		if (!core) return;
		SC.addMessage(core, '<span class="nick-col" style="color:' + color + '">***</span> <span class="sep">│</span> <span style="color:' + color + '">' + SC.esc(text) + '</span>');
	}

	function coreWindow() {
		for (const k in SC.windows) {
			if (SC.windows[k].fullName === 'core.weechat') return k;
		}
		return null;
	}

	function connect(o) {
		opts = o;
		ready = false;
		loginError('Connecting...');
		open();
	}

	function open() {
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
		callbacks = {};
		queue = Promise.resolve();
		stage = 'connecting';
		if (ws) { const s = ws; ws = null; s.close(); }
		const url = (opts.tls ? 'wss://' : 'ws://') + opts.host + ':' + opts.port + '/weechat';
		const sock = new WebSocket(url);
		ws = sock;
		sock.binaryType = 'arraybuffer';

		sock.onopen = function () {
			stage = 'handshake';
			request('handshake password_hash_algo=pbkdf2+sha512:pbkdf2+sha256:sha512:sha256,compression=zlib', onHandshake);
			handshakeTimer = setTimeout(function () {
				fail('No handshake reply from relay (WeeChat 2.9 or newer is required, and the port must be a "weechat" protocol relay).');
			}, 5000);
		};

		sock.onmessage = function (e) {
			const data = e.data;
			queue = queue.then(function () {
				const view = new DataView(data);
				const jobs = [];
				let off = 0;
				while (off + 5 <= data.byteLength) {
					const len = view.getUint32(off);
					if (len < 5) break;
					jobs.push(decodeMessage(data.slice(off, off + len)));
					off += len;
				}
				return Promise.all(jobs);
			}).then(function (msgs) {
				if (sock !== ws) return;
				msgs.forEach(dispatch);
			}).catch(function (err) {
				console.error('WeeChat relay:', err);
			});
		};

		// Wait for pending decodes so a final message (e.g. a failed handshake) is handled first
		sock.onclose = function () {
			queue = queue.then(function () {
				if (sock !== ws) return;
				clearTimeout(handshakeTimer);
				ws = null;
				onClose();
			});
		};
	}

	function onClose() {
		if (stage === 'failed') return;
		const wasStage = stage;
		stage = 'closed';
		if (ready || (reconnecting() && wasStage === 'connecting')) {
			if (opts.totpOn) {
				backToLogin('Disconnected from relay. Enter a new TOTP code to reconnect.');
				totpEl.classList.remove('hidden');
				totpEl.value = '';
				return;
			}
			localNotice('Disconnected from relay. Reconnecting in 15 seconds...', '#f00');
			reconnectTimer = setTimeout(function () {
				localNotice('Attempting to reconnect...', '#888');
				open();
			}, 15000);
			return;
		}
		if (wasStage === 'connecting') {
			fail('Could not connect to the relay. Check host, port, TLS setting, and that the TLS certificate is valid.');
		} else if (wasStage === 'auth') {
			fail('Authentication failed (wrong password or TOTP code).');
		} else {
			fail('Connection closed by relay during ' + wasStage + '.');
		}
	}

	function reconnecting() {
		return !appEl.classList.contains('hidden');
	}

	function fail(text) {
		stage = 'failed';
		clearTimeout(handshakeTimer);
		if (ws) { const s = ws; ws = null; s.close(); }
		backToLogin(text);
	}

	function backToLogin(text) {
		ready = false;
		appEl.classList.add('hidden');
		loginEl.classList.remove('hidden');
		loginError(text);
	}

	function hex(bytes) {
		return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
	}

	function unhex(h) {
		const out = new Uint8Array(h.length / 2);
		for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
		return out;
	}

	function onHandshake(msg) {
		clearTimeout(handshakeTimer);
		const h = msg.objects[0] || {};
		const algo = h.password_hash_algo;
		if (!algo) {
			fail('Relay and client share no password hash algorithm. This client requires one of: pbkdf2+sha512, pbkdf2+sha256, sha512, sha256 (relay.network.password_hash_algo).');
			return;
		}
		opts.totpOn = h.totp === 'on';
		if (opts.totpOn && !opts.totp) {
			totpEl.classList.remove('hidden');
			totpEl.focus();
			fail('This relay requires a TOTP code.');
			return;
		}

		const enc = new TextEncoder();
		const pw = enc.encode(opts.password);
		const clientNonce = crypto.getRandomValues(new Uint8Array(16));
		const salt = new Uint8Array(unhex(h.nonce).length + clientNonce.length);
		salt.set(unhex(h.nonce));
		salt.set(clientNonce, salt.length - clientNonce.length);
		const iterations = parseInt(h.password_hash_iterations, 10);
		const sha = algo.indexOf('sha512') !== -1 ? 'SHA-512' : 'SHA-256';

		let hashed;
		if (algo.indexOf('pbkdf2') === 0) {
			hashed = crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']).then(function (key) {
				return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: sha, salt: salt, iterations: iterations }, key, sha === 'SHA-512' ? 512 : 256);
			}).then(function (bits) {
				return algo + ':' + hex(salt) + ':' + iterations + ':' + hex(new Uint8Array(bits));
			});
		} else {
			const data = new Uint8Array(salt.length + pw.length);
			data.set(salt);
			data.set(pw, salt.length);
			hashed = crypto.subtle.digest(sha, data).then(function (d) {
				return algo + ':' + hex(salt) + ':' + hex(new Uint8Array(d));
			});
		}

		hashed.then(function (ph) {
			stage = 'auth';
			send('init password_hash=' + ph + (opts.totp ? ',totp=' + opts.totp : ''));
			request('info version', function () {
				stage = 'ready';
				loadAll();
			});
		});
	}

	// ============================================================
	//  Buffers / lines
	// ============================================================
	function loadAll() {
		request('hdata buffer:gui_buffers(*) number,full_name,short_name,title,local_variables,nicklist,hidden', onBuffers);
		request('hdata hotlist:gui_hotlist(*)', onHotlist);
		send('sync');
	}

	function bufferWindow(b, ptr) {
		return {
			messages: [], nicks: [], unread: 0, mentioned: false,
			ptr: ptr,
			number: b.number,
			fullName: b.full_name,
			label: b.short_name || b.full_name,
			title: b.title || '',
			isChan: !!b.nicklist,
			nick: (b.local_variables && b.local_variables.nick) || '',
			vars: b.local_variables || {},
			hidden: !!b.hidden,
			loaded: false, loading: false, pending: [],
			nicksLoaded: false
		};
	}

	function onBuffers(msg) {
		const active = SC.windows[SC.getActive()];
		if (active && active.fullName) lastActiveName = active.fullName;
		for (const k in SC.windows) delete SC.windows[k];

		(msg.objects[0] || []).forEach(function (b) {
			const ptr = b.__path[0];
			SC.windows[ptr] = bufferWindow(b, ptr);
		});

		let target = null;
		for (const k in SC.windows) {
			if (SC.windows[k].fullName === lastActiveName) target = k;
		}
		target = target || coreWindow() || Object.keys(SC.windows)[0];

		if (!ready) {
			ready = true;
			loginError('');
			totpEl.value = '';
			opts.totp = '';
			totpEl.classList.add('hidden');
			loginEl.classList.add('hidden');
			appEl.classList.remove('hidden');
		}
		SC.switchWindow(target);
	}

	function onHotlist(msg) {
		(msg.objects[0] || []).forEach(function (h) {
			const win = SC.windows[h.buffer];
			if (!win || h.buffer === SC.getActive()) return;
			const c = h.count || [0, 0, 0, 0];
			win.unread = (c[1] || 0) + (c[2] || 0) + (c[3] || 0);
			win.mentioned = (c[2] || 0) + (c[3] || 0) > 0;
		});
		SC.renderChannelList();
	}

	function lineKey(ld) {
		return ld.date + '|' + ld.prefix + '|' + ld.message;
	}

	function loadLines(ptr) {
		const win = SC.windows[ptr];
		win.loading = true;
		win.pending = [];
		request('hdata buffer:' + ptr + '/own_lines/last_line(-' + BACKLOG + ')/data', function (msg) {
			if (SC.windows[ptr] !== win) return;
			const lines = (msg.objects[0] || []).filter(function (ld) { return ld.displayed; }).reverse();
			const seen = {};
			win.messages = lines.map(function (ld) {
				seen[lineKey(ld)] = true;
				return SC.stampLine(lineHtml(ld), ld.date * 1000);
			});
			win.pending.forEach(function (p) {
				if (!seen[p.key]) win.messages.push(p.line);
			});
			win.pending = [];
			win.loading = false;
			win.loaded = true;
			if (SC.getActive() === ptr) SC.renderMessages();
		});
	}

	function onLineAdded(ld) {
		const ptr = ld.buffer;
		const win = SC.windows[ptr];
		if (!win || !ld.displayed) return;
		const line = SC.stampLine(lineHtml(ld), ld.date * 1000);
		const active = SC.getActive() === ptr;

		if (win.loaded) {
			win.messages.push(line);
			if (win.messages.length > 5000) win.messages.shift();
			if (active) SC.appendLine(line);
		} else if (win.loading) {
			win.pending.push({ key: lineKey(ld), line: line });
		}

		if (!active) {
			if (ld.notify_level >= 1) win.unread++;
			if (ld.highlight || ld.notify_level >= 2) win.mentioned = true;
			SC.renderChannelList();
		}
		if (ld.highlight) {
			SC.playNotificationSound();
			SC.sendDesktopNotification(stripColors(ld.prefix) + ' in ' + win.label, stripColors(ld.message));
		}
	}

	function updateBuffer(ptr, b) {
		const win = SC.windows[ptr];
		if (!win) return;
		if (b.number !== undefined) win.number = b.number;
		if (b.full_name !== undefined) win.fullName = b.full_name;
		if (b.short_name !== undefined) win.label = b.short_name || b.full_name;
		if (b.title !== undefined) win.title = b.title || '';
		if (b.local_variables) {
			win.vars = b.local_variables;
			win.nick = b.local_variables.nick || '';
		}
		SC.renderChannelList();
		if (SC.getActive() === ptr) {
			SC.updateTopicBar();
			SC.updateInputNick();
		}
	}

	// ============================================================
	//  Nicklist
	// ============================================================
	function nickEntry(n) {
		return (n.prefix || '').trim() + n.name;
	}

	function bareNick(entry) {
		return entry.replace(/^[~&@%+]+/, '');
	}

	function onNicklist(items, isDiff) {
		const touched = {};
		items.forEach(function (n) {
			const ptr = n.__path[0];
			const win = SC.windows[ptr];
			if (!win) return;
			if (!isDiff && !touched[ptr]) {
				win.nicks = [];
				win.nicksLoaded = true;
			}
			touched[ptr] = true;
			if (!win.nicksLoaded || n.group) return;
			const diff = isDiff ? String.fromCharCode(n._diff) : '+';
			const idx = win.nicks.findIndex(function (e) { return bareNick(e) === n.name; });
			if (diff === '-') {
				if (idx !== -1) win.nicks.splice(idx, 1);
			} else if (diff === '+' || diff === '*') {
				if (!n.visible) return;
				if (idx !== -1) win.nicks[idx] = nickEntry(n);
				else win.nicks.push(nickEntry(n));
			}
		});
		if (touched[SC.getActive()]) {
			SC.renderNickList();
			SC.updateInputNick();
			SC.updateTopicBar();
		}
	}

	// ============================================================
	//  Event dispatch
	// ============================================================
	function dispatch(msg) {
		const id = msg.id;
		if (id && callbacks[id]) {
			const cb = callbacks[id];
			delete callbacks[id];
			cb(msg);
			return;
		}
		const items = msg.objects[0] || [];

		switch (id) {
		case '_buffer_line_added':
			items.forEach(onLineAdded);
			break;

		case '_buffer_opened':
			items.forEach(function (b) {
				const ptr = b.__path[0];
				SC.windows[ptr] = bufferWindow(b, ptr);
				const lv = b.local_variables || {};
				if (pendingQuery && lv.type === 'private' && lv.channel && lv.channel.toLowerCase() === pendingQuery.toLowerCase()) {
					pendingQuery = null;
					SC.switchWindow(ptr);
				}
			});
			SC.renderChannelList();
			break;

		case '_buffer_closing':
			items.forEach(function (b) {
				const ptr = b.__path[0];
				delete SC.windows[ptr];
				if (SC.getActive() === ptr) SC.switchWindow(coreWindow() || Object.keys(SC.windows)[0]);
			});
			SC.renderChannelList();
			break;

		case '_buffer_moved': case '_buffer_merged': case '_buffer_unmerged':
		case '_buffer_renamed': case '_buffer_title_changed':
		case '_buffer_localvar_added': case '_buffer_localvar_changed': case '_buffer_localvar_removed':
			items.forEach(function (b) { updateBuffer(b.__path[0], b); });
			break;

		case '_buffer_hidden': case '_buffer_unhidden':
			items.forEach(function (b) {
				const win = SC.windows[b.__path[0]];
				if (win) win.hidden = (id === '_buffer_hidden');
			});
			SC.renderChannelList();
			break;

		case '_buffer_cleared':
			items.forEach(function (b) {
				const win = SC.windows[b.__path[0]];
				if (!win) return;
				win.messages = [];
				if (SC.getActive() === b.__path[0]) SC.renderMessages();
			});
			break;

		case '_nicklist':
			onNicklist(items, false);
			break;

		case '_nicklist_diff':
			onNicklist(items, true);
			break;

		case '_upgrade':
			localNotice('WeeChat is upgrading...', '#888');
			break;

		case '_upgrade_ended':
			loadAll();
			break;
		}
	}

	// ============================================================
	//  Hooks called from script.js
	// ============================================================
	function onSwitch(ptr) {
		const win = SC.windows[ptr];
		if (!win || !ws) return;
		completion = null;
		if (!win.loaded && !win.loading) loadLines(ptr);
		if (win.isChan && !win.nicksLoaded) {
			request('nicklist ' + ptr, function (msg) { onNicklist(msg.objects[0] || [], false); });
		}
		send('input ' + ptr + ' /buffer set hotlist -1');
	}

	function input(ptr, text) {
		completion = null;
		send('input ' + ptr + ' ' + text);
	}

	function query(nick) {
		const server = SC.windows[SC.getActive()].vars.server;
		for (const k in SC.windows) {
			const v = SC.windows[k].vars;
			if (v.type === 'private' && v.server === server && v.channel && v.channel.toLowerCase() === nick.toLowerCase()) return SC.switchWindow(k);
		}
		pendingQuery = nick;
		input(SC.getActive(), '/query ' + nick);
	}

	function complete(inputEl) {
		const ptr = SC.getActive();
		if (completion && completion.value === inputEl.value && completion.list.length) {
			completion.idx = (completion.idx + 1) % completion.list.length;
			applyCompletion(inputEl);
			return;
		}
		const value = inputEl.value;
		request('completion ' + ptr + ' ' + inputEl.selectionStart + ' ' + value, function (msg) {
			const c = (msg.objects[0] || [])[0];
			if (!c || !c.list || !c.list.length || inputEl.value !== value || SC.getActive() !== ptr) return;
			completion = { list: c.list, idx: 0, before: value.substring(0, c.pos_start), after: value.substring(c.pos_end + 1), space: c.add_space };
			applyCompletion(inputEl);
		});
	}

	function applyCompletion(inputEl) {
		const word = completion.list[completion.idx] + (completion.space ? ' ' : '');
		inputEl.value = completion.before + word + completion.after;
		const pos = completion.before.length + word.length;
		inputEl.setSelectionRange(pos, pos);
		completion.value = inputEl.value;
	}

	function updateTopicBar(el) {
		const win = SC.windows[SC.getActive()];
		if (!win) { el.classList.add('hidden'); return; }
		el.innerHTML =
			'<span class="topic-channel">' + SC.esc(win.label) + '</span>' +
			(win.isChan ? '<span class="topic-meta"> (' + win.nicks.length + ')</span>' : '') + ' ' +
			segsHtml(parseColors(win.title));
		el.title = stripColors(win.title);
		el.classList.remove('hidden');
	}

	window.WeeChat = {
		connect: connect,
		onSwitch: onSwitch,
		input: input,
		query: query,
		complete: complete,
		updateTopicBar: updateTopicBar
	};
})();
