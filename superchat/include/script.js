(function () {
	'use strict';

	const BLACKHOLE = '#blackhole';
	const NICK_COL_MIN = 4;
	const NICK_COL_MAX = 20;

	// --- State ---
	let nick = '';
	let serverHost = '';
	let serverPort = 7000;
	let useSSL = true;
	let autoJoinChannels = [];
	let ws = null;
	let registered = false;
	let activeWindow = 'Status';
	const windows = {};
	const nickColors = new Map();
	const batches = {};
	const channelModes = {};
	const channelTopics = {};
	const historyLoaded = {};
	let availableCaps = [];
	let enabledCaps = [];
	let commandHistory = [];
	let historyIndex = -1;
	// Buffer list and nicklist start collapsed on mobile
	let showChanlist = window.innerWidth > 600;
	let showNicklist = window.innerWidth > 600;
	let notificationsEnabled = false;
	let fontSize = 12;
	let reconnectTimer = null;
	let wcMode = false;

	// --- Notification sound (short beep generated via AudioContext) ---
	let audioCtx = null;
	function playNotificationSound() {
		try {
			if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
			const osc = audioCtx.createOscillator();
			const gain = audioCtx.createGain();
			osc.connect(gain);
			gain.connect(audioCtx.destination);
			osc.type = 'sine';
			osc.frequency.setValueAtTime(880, audioCtx.currentTime);
			osc.frequency.setValueAtTime(660, audioCtx.currentTime + 0.08);
			gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
			osc.start(audioCtx.currentTime);
			osc.stop(audioCtx.currentTime + 0.25);
		} catch (e) { /* ignore audio errors */ }
	}

	function requestNotificationPermission() {
		if ('Notification' in window && Notification.permission === 'default') {
			Notification.requestPermission().then(function (perm) {
				notificationsEnabled = (perm === 'granted');
			});
		} else if ('Notification' in window && Notification.permission === 'granted') {
			notificationsEnabled = true;
		}
	}

	function sendDesktopNotification(title, body) {
		if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
		if (document.hasFocus()) return;
		try {
			const n = new Notification(title, { body: body, icon: 'logo.png', tag: 'irc-mention' });
			setTimeout(function () { n.close(); }, 5000);
		} catch (e) { /* ignore */ }
	}

	// --- mIRC color palette (0-98) ---
	const IRC_COLORS = [
		'#ffffff', '#000000', '#00007f', '#009300', '#ff0000', '#7f0000',
		'#9c009c', '#fc7f00', '#ffff00', '#00fc00', '#009393', '#00ffff',
		'#0000fc', '#ff00ff', '#7f7f7f', '#d2d2d2',
		'#470000', '#472100', '#474700', '#324700', '#004700', '#00472c',
		'#004747', '#002747', '#000047', '#2e0047', '#470047', '#47002a',
		'#740000', '#743a00', '#747400', '#517400', '#007400', '#007449',
		'#007474', '#004074', '#000074', '#4b0074', '#740074', '#740045',
		'#b50000', '#b56300', '#b5b500', '#7db500', '#00b500', '#00b571',
		'#00b5b5', '#0063b5', '#0000b5', '#7500b5', '#b500b5', '#b5006b',
		'#ff0000', '#ff8c00', '#ffff00', '#b2ff00', '#00ff00', '#00ffa0',
		'#00ffff', '#008cff', '#0000ff', '#a500ff', '#ff00ff', '#ff0098',
		'#ff5959', '#ffb459', '#ffff71', '#cfff60', '#6fff6f', '#65ffc9',
		'#6dffff', '#59b4ff', '#5959ff', '#c459ff', '#ff66ff', '#ff59bc',
		'#ff9c9c', '#ffd39c', '#ffff9c', '#e2ff9c', '#9cff9c', '#9cffdb',
		'#9cffff', '#9cd3ff', '#9c9cff', '#dc9cff', '#ff9cff', '#ff94d3',
		'#000000', '#131313', '#282828', '#363636', '#4d4d4d', '#656565',
		'#818181', '#9f9f9f', '#bcbcbc', '#e2e2e2', '#ffffff'
	];

	const PREFIX_COLORS = { '~': '#0f0', '&': '#f00', '@': '#f00', '%': '#ff0', '+': '#a8a8ff' };
	const PREFIX_LABELS = {
		'~': 'Owner',
		'&': 'Admin',
		'@': 'Operator',
		'%': 'Half-Op',
		'+': 'Voice',
		'': 'Regular'
	};

	// --- DOM ---
	const loginEl         = document.getElementById('login');
	const loginServerEl   = document.getElementById('login-server');
	const loginPortEl     = document.getElementById('login-port');
	const loginSSLEl      = document.getElementById('login-ssl');
	const loginNickEl     = document.getElementById('login-nick');
	const loginChannelsEl = document.getElementById('login-channels');
	const loginRememberEl = document.getElementById('login-remember');
	const loginBtnEl      = document.getElementById('login-btn');
	const loginIrcEl      = document.getElementById('login-irc');
	const loginWcEl       = document.getElementById('login-weechat');
	const loginWcServerEl = document.getElementById('login-wc-server');
	const loginWcPortEl   = document.getElementById('login-wc-port');
	const loginWcTLSEl    = document.getElementById('login-wc-tls');
	const loginWcPassEl   = document.getElementById('login-wc-password');
	const loginWcTotpEl   = document.getElementById('login-wc-totp');
	const appEl           = document.getElementById('app');
	const channelsEl    = document.getElementById('channels');
	const topicbarEl    = document.getElementById('topicbar');
	const messagesEl    = document.getElementById('messages');
	const nicklistEl    = document.getElementById('nicklist');
	const inputEl       = document.getElementById('input');
	const inputNickEl   = document.getElementById('input-nick');
	const toggleChanBtn = document.getElementById('toggle-chanlist');
	const toggleNickBtn = document.getElementById('toggle-nicklist');
	const listviewEl     = document.getElementById('listview');
	const listSearchEl   = document.getElementById('listview-search');
	const listStatusEl   = document.getElementById('listview-status');
	const listRowsEl     = document.getElementById('listview-rows');
	const inputPreviewEl = document.getElementById('input-preview');
	const formatBtn     = document.getElementById('format-btn');
	const formatPopEl   = document.getElementById('format-pop');
	const formatColorsEl = document.getElementById('format-colors');
	const formatMoreBtn = document.getElementById('format-more');
	const fontDecBtn = document.getElementById('font-decrease');
	const fontIncBtn = document.getElementById('font-increase');

	// --- Nick colors (LRU cache, 1000 max) ---
	function hashStr(s) {
		let h = 0;
		for (let i = 0; i < s.length; i++) {
			h = ((h << 5) - h) + s.charCodeAt(i);
			h |= 0;
		}
		return Math.abs(h);
	}

	function getNickColor(n) {
		if (nickColors.has(n)) {
			const c = nickColors.get(n);
			nickColors.delete(n);
			nickColors.set(n, c);
			return c;
		}
		const hue = hashStr(n) % 360;
		const c = 'hsl(' + hue + ',70%,65%)';
		nickColors.set(n, c);
		if (nickColors.size > 1000) {
			nickColors.delete(nickColors.keys().next().value);
		}
		return c;
	}

	// --- HTML escape ---
	function esc(t) {
		return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	// --- Chat nick column + separator ---
	function chatNick(displayNick, color) {
		return '<span class="nick-col" style="color:' + color + '" title="' + esc(displayNick) + '">' + esc(displayNick) + '</span> <span class="sep">\u2502</span> ';
	}

	// --- IRC formatting → HTML ---
	function formatIRC(text) {
		let out = '';
		let bold = false, italic = false, underline = false;
		let fg = null, bg = null;
		let i = 0;
		let spanOpen = false;

		function applyStyle() {
			if (spanOpen) { out += '</span>'; spanOpen = false; }
			const s = [];
			if (bold)      s.push('font-weight:bold');
			if (italic)    s.push('font-style:italic');
			if (underline) s.push('text-decoration:underline');
			if (fg !== null && IRC_COLORS[fg]) s.push('color:' + IRC_COLORS[fg]);
			if (bg !== null && IRC_COLORS[bg]) s.push('background-color:' + IRC_COLORS[bg]);
			if (s.length) {
				out += '<span style="' + s.join(';') + '">';
				spanOpen = true;
			}
		}

		while (i < text.length) {
			const c = text.charCodeAt(i);

			if (c === 0x02) {
				bold = !bold; applyStyle(); i++;
			} else if (c === 0x1D) {
				italic = !italic; applyStyle(); i++;
			} else if (c === 0x1F) {
				underline = !underline; applyStyle(); i++;
			} else if (c === 0x16) {
				const tmp = fg; fg = bg; bg = tmp; applyStyle(); i++;
			} else if (c === 0x0F) {
				bold = italic = underline = false;
				fg = bg = null; applyStyle(); i++;
			} else if (c === 0x03) {
				i++;
				if (i < text.length && text[i] >= '0' && text[i] <= '9') {
					let fs = text[i++];
					if (i < text.length && text[i] >= '0' && text[i] <= '9') fs += text[i++];
					fg = parseInt(fs, 10);
					if (i < text.length && text[i] === ',') {
						const ci = i + 1;
						if (ci < text.length && text[ci] >= '0' && text[ci] <= '9') {
							i = ci;
							let bs = text[i++];
							if (i < text.length && text[i] >= '0' && text[i] <= '9') bs += text[i++];
							bg = parseInt(bs, 10);
						}
					}
				} else {
					fg = bg = null;
				}
				applyStyle();
			} else if (c === 0x04) {
				i++;
				if (i + 5 < text.length) {
					const hex = text.substring(i, i + 6);
					if (/^[0-9a-fA-F]{6}$/.test(hex)) {
						if (spanOpen) { out += '</span>'; spanOpen = false; }
						const s = [];
						if (bold)      s.push('font-weight:bold');
						if (italic)    s.push('font-style:italic');
						if (underline) s.push('text-decoration:underline');
						s.push('color:#' + hex);
						if (bg !== null && IRC_COLORS[bg]) s.push('background-color:' + IRC_COLORS[bg]);
						out += '<span style="' + s.join(';') + '">';
						spanOpen = true;
						i += 6;
						continue;
					}
				}
			} else {
				if (text[i] === '&')      out += '&amp;';
				else if (text[i] === '<') out += '&lt;';
				else if (text[i] === '>') out += '&gt;';
				else                       out += text[i];
				i++;
			}
		}

		if (spanOpen) out += '</span>';
		return linkify(out);
	}

	// --- Linkify URLs in HTML ---
	function linkify(html) {
		// Match URLs - must be careful not to match inside existing HTML tags
		const urlRegex = /(?:^|[^"'>])(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
		return html.replace(urlRegex, function(match, url) {
			// If match starts with a character (not start of string), preserve it
			const prefix = match[0] !== 'h' && match[0] !== 'w' ? match[0] : '';
			const actualUrl = prefix ? match.slice(1) : match;
			const href = actualUrl.startsWith('www.') ? 'http://' + actualUrl : actualUrl;
			return prefix + '<a href="' + href + '" target="_blank" rel="noopener noreferrer" style="color:#00a8ff;text-decoration:underline">' + actualUrl + '</a>';
		});
	}

	function stripIRC(text) {
		return text.replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, '')
		           .replace(/\x04([0-9a-fA-F]{6})?/g, '')
		           .replace(/[\x02\x1D\x1F\x16\x0F]/g, '');
	}

	// ============================================================
	//  Window / tab management
	// ============================================================
	function createWindow(name) {
		if (!windows[name]) {
			windows[name] = { messages: [], nicks: [], unread: 0, mentioned: false };
		}
		renderChannelList();
	}

	function switchWindow(name) {
		if (!windows[name]) createWindow(name);
		activeWindow = name;
		windows[name].unread = 0;
		windows[name].mentioned = false;
		windows[name].activity = false;
		renderChannelList();
		renderMessages();
		updateNicklistVisibility();
		renderNickList();
		updateInputNick();
		updateTopicBar();
		updateStatusBar();
		updateListView();
		if (wcMode) WeeChat.onSwitch(name);
		// Don't auto-focus input on mobile
		if (window.innerWidth > 600) {
			inputEl.focus();
		}
	}

	function stampLine(html, timestamp) {
		const t = timestamp ? new Date(timestamp) : new Date();
		const ts = ('0' + t.getHours()).slice(-2) + ':' +
		           ('0' + t.getMinutes()).slice(-2) + ':' +
		           ('0' + t.getSeconds()).slice(-2);
		return '<span class="timestamp">' + ts + '</span> ' + html;
	}

	// Buffer kind for activity colors: 'channel', 'private' or 'other' (server/status/special buffers)
	function windowKind(name) {
		const win = windows[name];
		if (win && win.vars) return win.vars.type === 'channel' || win.vars.type === 'private' ? win.vars.type : 'other';
		if (isChanWindow(name)) return 'channel';
		return (name === 'Status' || name === 'Hilights' || (win && win.listView)) ? 'other' : 'private';
	}

	// Inactive tab colors: yellow = channel highlight or new private message, cyan = channel message,
	// brighter white = any other activity; server/special buffers only ever get brighter white
	function markActivity(name, isMessage, isHighlight) {
		const win = windows[name];
		if (!win || name === activeWindow) return;
		const kind = windowKind(name);
		if (kind === 'channel' && isHighlight) win.mentioned = true;
		else if (kind === 'channel' && isMessage) win.unread++;
		else if (kind === 'private' && isMessage) win.mentioned = true;
		else win.activity = true;
		renderChannelList();
	}

	function addMessage(windowName, html, timestamp, isMessage) {
		if (!windows[windowName]) createWindow(windowName);
		const line = stampLine(html, timestamp);
		const win = windows[windowName];
		win.messages.push(line);
		if (win.messages.length > 5000) win.messages.shift();

		if (windowName === activeWindow) appendLine(line);
		else markActivity(windowName, isMessage, false);
	}

	// --- Rendering ---
	function appendLine(html) {
		const atBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 20;
		const div = document.createElement('div');
		div.className = 'line';
		div.innerHTML = html;
		messagesEl.appendChild(div);
		while (messagesEl.children.length > 5000) messagesEl.removeChild(messagesEl.firstChild);
		if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function renderMessages() {
		messagesEl.innerHTML = '';
		const win = windows[activeWindow];
		if (!win) return;
		const frag = document.createDocumentFragment();
		win.messages.forEach(function (m) {
			const div = document.createElement('div');
			div.className = 'line';
			div.innerHTML = m;
			frag.appendChild(div);
		});
		messagesEl.appendChild(frag);
		requestAnimationFrame(function () {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		});
	}

	function renderChannelList() {
		channelsEl.innerHTML = '';
		const names = Object.keys(windows).sort(function (a, b) {
			return (windows[a].number || 0) - (windows[b].number || 0);
		});
		for (const name of names) {
			const tab = document.createElement('div');
			const win = windows[name];
			if (win.hidden) continue;
			let cls = 'tab';
			if (name === activeWindow) {
				cls += ' active';
			} else if (win.mentioned) {
				cls += ' mentioned';
			} else if (win.unread > 0) {
				cls += ' unread';
			} else if (win.activity) {
				cls += ' activity';
			}
			if (name === 'Status' || (win.vars && win.vars.type === 'server')) cls += ' server';
			tab.className = cls;
			tab.textContent = win.label || name;
			tab.onclick = (function (n) { return function () { switchWindow(n); }; })(name);
			channelsEl.appendChild(tab);
		}
	}

	function renderNickList() {
		nicklistEl.innerHTML = '';
		const win = windows[activeWindow];
		if (!win || !win.nicks.length) return;

		const groups = { '~': [], '&': [], '@': [], '%': [], '+': [], '': [] };

		win.nicks.forEach(function (n) {
			const bare = n.replace(/^[~&@%+]+/, '');
			const pfx = n.slice(0, n.length - bare.length);
			const topPfx = pfx ? pfx[0] : '';
			const key = groups[topPfx] !== undefined ? topPfx : '';
			groups[key].push({ bare: bare, pfx: pfx, sort: bare.toLowerCase() });
		});

		const order = ['~', '&', '@', '%', '+', ''];
		const frag = document.createDocumentFragment();

		order.forEach(function (key) {
			const list = groups[key];
			if (!list.length) return;

			list.sort(function (a, b) { return a.sort.localeCompare(b.sort); });

			const header = document.createElement('div');
			header.className = 'nick-category';
			header.textContent = PREFIX_LABELS[key] + ' (' + list.length + ')';
			frag.appendChild(header);

			list.forEach(function (entry) {
				const div = document.createElement('div');
				div.className = 'nick';
				const pfxColor = entry.pfx ? (PREFIX_COLORS[entry.pfx[0]] || '#666') : '';
				const pfxHtml = entry.pfx ? '<span style="color:' + pfxColor + '">' + esc(entry.pfx) + '</span>' : '';
				div.innerHTML = pfxHtml + esc(entry.bare);
				div.title = entry.bare;
				div.ondblclick = (function (b) { return function () {
					if (wcMode) return WeeChat.query(b);
					if (!windows[b]) createWindow(b);
					switchWindow(b);
				}; })(entry.bare);
				frag.appendChild(div);
			});
		});

		nicklistEl.appendChild(frag);
	}

	// --- Panel visibility ---
	function isChanWindow(name) {
		if (windows[name] && windows[name].isChan !== undefined) return windows[name].isChan;
		return name && (name[0] === '#' || name[0] === '&');
	}

	function updateNicklistVisibility() {
		if (showNicklist && isChanWindow(activeWindow)) {
			nicklistEl.classList.remove('hidden');
		} else {
			nicklistEl.classList.add('hidden');
		}
	}

	function updateChanlistVisibility() {
		if (showChanlist) {
			channelsEl.classList.remove('hidden');
		} else {
			channelsEl.classList.add('hidden');
		}
	}

	function updateInputNick() {
		const win = windows[activeWindow];
		const me = win && win.nick !== undefined ? win.nick : nick;
		const pfx = isChanWindow(activeWindow) ? getNickPrefix(activeWindow, me) : '';
		inputNickEl.textContent = me ? pfx + me + ':' : '';
		inputNickEl.style.color = getNickColor(me);
	}

	function updateTopicBar() {
		if (windows[activeWindow] && windows[activeWindow].listView) {
			topicbarEl.classList.add('hidden');
			return;
		}
		if (wcMode) return WeeChat.updateTopicBar(topicbarEl);
		if (isChanWindow(activeWindow)) {
			const win = windows[activeWindow];
			const count = win ? win.nicks.length : 0;
			const mode = channelModes[activeWindow] || '';
			const modeStr = mode ? ' [+' + mode + ']' : '';
			const topic = channelTopics[activeWindow] || '';
			topicbarEl.innerHTML =
				'<span class="topic-channel">' + esc(activeWindow) + '</span>' +
				'<span class="topic-meta">' + esc(modeStr) + ' (' + count + ')</span> ' +
				(topic ? formatIRC(topic) : '');
			topicbarEl.title = topic ? stripIRC(topic) : '';
			topicbarEl.classList.remove('hidden');
		} else {
			topicbarEl.classList.add('hidden');
			topicbarEl.title = '';
		}
	}

	function updateStatusBar() {
		// Status bar now only has toggle buttons and the github link — nothing dynamic needed
	}

	// ============================================================
	//  IRC protocol
	// ============================================================
	function send(data) {
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(data + '\r\n');
		}
	}

	function parseMessage(raw) {
		let tags = {};
		let i = 0;

		if (raw[0] === '@') {
			const sp = raw.indexOf(' ');
			raw.substring(1, sp).split(';').forEach(function (t) {
				const eq = t.indexOf('=');
				if (eq === -1) tags[t] = '';
				else tags[t.substring(0, eq)] = t.substring(eq + 1);
			});
			i = sp + 1;
		}

		while (i < raw.length && raw[i] === ' ') i++;

		let prefix = '';
		if (raw[i] === ':') {
			const sp = raw.indexOf(' ', i);
			prefix = raw.substring(i + 1, sp);
			i = sp + 1;
		}

		while (i < raw.length && raw[i] === ' ') i++;

		const rest = raw.substring(i);
		const parts = [];
		let j = 0;
		while (j < rest.length) {
			if (rest[j] === ':') { parts.push(rest.substring(j + 1)); break; }
			const sp = rest.indexOf(' ', j);
			if (sp === -1) { parts.push(rest.substring(j)); break; }
			parts.push(rest.substring(j, sp));
			j = sp + 1;
			while (j < rest.length && rest[j] === ' ') j++;
		}

		const command = parts.length ? parts[0].toUpperCase() : '';
		const prms = parts.slice(1);
		const m = prefix.match(/^([^!@]+)/);
		const fromNick = m ? m[1] : prefix;

		return { tags: tags, prefix: prefix, fromNick: fromNick, command: command, params: prms };
	}

	// ============================================================
	//  Message handler
	// ============================================================
	function handleMessage(msg) {
		const tags      = msg.tags;
		const fromNick  = msg.fromNick;
		const command   = msg.command;
		const p         = msg.params;
		const timestamp = tags['time'] || null;
		const batchId   = tags['batch'] || null;

		if (batchId && batches[batchId]) {
			batches[batchId].messages.push(msg);
			return;
		}

		switch (command) {

		case 'PING':
			send('PONG :' + (p[0] || ''));
			break;

		case 'CAP': {
			const sub = p[1];
			if (sub === 'LS') {
				const isMulti = p[2] === '*';
				const capsStr = isMulti ? p[3] : p[2];
				if (capsStr) {
					availableCaps = availableCaps.concat(
						capsStr.split(' ').filter(Boolean).map(function (c) { return c.split('=')[0]; })
					);
				}
				if (isMulti) break;
				const desired = [
					'server-time', 'batch', 'message-tags',
					'draft/chathistory', 'chathistory',
					'draft/event-playback'
				];
				const toReq = desired.filter(function (c) { return availableCaps.indexOf(c) !== -1; });
				if (toReq.length) send('CAP REQ :' + toReq.join(' '));
				else send('CAP END');
			} else if (sub === 'ACK') {
				const acked = (p[p.length - 1] || '').split(' ').filter(Boolean);
				enabledCaps = enabledCaps.concat(acked);
				send('CAP END');
			} else if (sub === 'NAK') {
				send('CAP END');
			}
			break;
		}

		case 'BATCH': {
			const ref = p[0];
			if (ref && ref[0] === '+') {
				const id = ref.slice(1);
				batches[id] = { type: p[1] || '', target: p[2] || null, messages: [] };
			} else if (ref && ref[0] === '-') {
				const id = ref.slice(1);
				if (batches[id]) {
					const batch = batches[id];
					delete batches[id];
					batch.messages.forEach(function (m) { handleMessage(m); });
				}
			}
			break;
		}

		case '001':
			registered = true;
			nick = p[0] || nick;
			addMessage('Status', chatNick('***', '#0f0') + '<span style="color:#0f0">Connected as ' + esc(nick) + '</span>', timestamp);
			updateInputNick();
			updateStatusBar();
			if (autoJoinChannels.length) {
				setTimeout(function () {
					addMessage('Status', chatNick('***', '#888') + '<span style="color:#888">Joining ' + esc(autoJoinChannels.join(', ')) + '...</span>');
				}, 3000);
				setTimeout(function () {
					if (registered && autoJoinChannels.length) {
						send('JOIN ' + autoJoinChannels.join(','));
					}
				}, 5000);
			}
			break;

		case '002': case '003': case '004': case '005':
		case '250': case '251': case '252': case '253': case '254': case '255':
		case '265': case '266':
			addMessage('Status', chatNick('***', '#888') + '<span style="color:#888">' + formatIRC(p[p.length - 1] || '') + '</span>', timestamp);
			break;

		case '375': case '372':
			addMessage('Status', chatNick('***', '#888') + formatIRC(p[p.length - 1] || ''), timestamp);
			break;

		case '376':
			addMessage('Status', chatNick('***', '#888') + formatIRC(p[p.length - 1] || ''), timestamp);
			break;

		case '324': {
			const chan = p[1];
			const modeStr = p[2] || '';
			const clean = modeStr.replace(/^\+/, '');
			channelModes[chan] = clean;
			if (chan === activeWindow) updateTopicBar();
			break;
		}

		case '329':
			break;

		case '332': {
			const chan = p[1];
			if (!windows[chan]) createWindow(chan);
			channelTopics[chan] = p[2] || '';
			addMessage(chan, chatNick('***', '#888') + '<span style="color:#888">Topic: ' + formatIRC(p[2] || '') + '</span>', timestamp);
			if (chan === activeWindow) updateTopicBar();
			break;
		}

		case '333':
			break;

		case '353': {
			const chan = p[2];
			if (!windows[chan]) createWindow(chan);
			const names = (p[3] || '').split(' ').filter(Boolean);
			windows[chan].nicks = windows[chan].nicks.concat(names);
			const seen = {};
			windows[chan].nicks = windows[chan].nicks.filter(function (n) {
				const bare = n.replace(/^[~&@%+]+/, '');
				if (seen[bare]) return false;
				seen[bare] = true;
				return true;
			});
			break;
		}

		case '366': {
			const chan = p[1];
			if (chan === activeWindow) {
				renderNickList();
				updateInputNick();
				updateTopicBar();
			}
			send('MODE ' + chan);
			if (!historyLoaded[chan]) {
				historyLoaded[chan] = true;
				if (enabledCaps.indexOf('draft/chathistory') !== -1 || enabledCaps.indexOf('chathistory') !== -1) {
					send('CHATHISTORY LATEST ' + chan + ' * 50');
				}
			}
			break;
		}

		case 'JOIN': {
			const chan = p[0].split(' ')[0];

			// Auto-part #blackhole only on SuperNETs network
			if (fromNick === nick && chan.toLowerCase() === BLACKHOLE && serverHost.toLowerCase().includes('supernets')) {
				send('PART ' + chan);
				break;
			}

			if (fromNick === nick) {
				createWindow(chan);
				// Don't auto-switch to prevent force-join spam attacks (except channels joined from the channel list)
				if (pendingListJoin === chan.toLowerCase()) {
					pendingListJoin = null;
					switchWindow(chan);
				}
			} else if (windows[chan]) {
				if (windows[chan].nicks.indexOf(fromNick) === -1) {
					windows[chan].nicks.push(fromNick);
				}
			}
			if (windows[chan]) {
				addMessage(chan, chatNick('-->', '#555') + '<span style="color:#555">' + esc(fromNick) + ' has joined</span>', timestamp);
			}
			if (chan === activeWindow) {
				renderNickList();
				updateTopicBar();
			}
			break;
		}

		case 'PART': {
			const chan = p[0];
			const reason = p[1] || '';
			if (fromNick === nick) {
				delete windows[chan];
				delete channelModes[chan];
				delete channelTopics[chan];
				delete historyLoaded[chan];
				if (activeWindow === chan) switchWindow('Status');
				renderChannelList();
			} else if (windows[chan]) {
				windows[chan].nicks = windows[chan].nicks.filter(function (n) {
					return n.replace(/^[~&@%+]+/, '') !== fromNick;
				});
				addMessage(chan, chatNick('<--', '#555') + '<span style="color:#555">' + esc(fromNick) + ' has left' +
					(reason ? ' (' + esc(reason) + ')' : '') + '</span>', timestamp);
				if (chan === activeWindow) {
					renderNickList();
					updateTopicBar();
				}
			}
			break;
		}

		case 'QUIT': {
			const reason = p[0] || '';
			for (const chan in windows) {
				const idx = windows[chan].nicks.findIndex(function (n) {
					return n.replace(/^[~&@%+]+/, '') === fromNick;
				});
				if (idx !== -1) {
					windows[chan].nicks.splice(idx, 1);
					addMessage(chan, chatNick('<--', '#555') + '<span style="color:#555">' + esc(fromNick) + ' has quit' +
						(reason ? ' (' + esc(reason) + ')' : '') + '</span>', timestamp);
					if (chan === activeWindow) {
						renderNickList();
						updateTopicBar();
					}
				}
			}
			break;
		}

		case 'KICK': {
			const chan = p[0];
			const kicked = p[1];
			const reason = p[2] || '';
			if (windows[chan]) {
				windows[chan].nicks = windows[chan].nicks.filter(function (n) {
					return n.replace(/^[~&@%+]+/, '') !== kicked;
				});
				addMessage(chan, chatNick('<--', '#c00') + '<span style="color:#c00">' + esc(kicked) + ' was kicked by ' +
					esc(fromNick) + (reason ? ' (' + formatIRC(reason) + ')' : '') + '</span>', timestamp);
				if (kicked === nick) {
					delete windows[chan];
					delete channelModes[chan];
					delete channelTopics[chan];
					delete historyLoaded[chan];
					if (activeWindow === chan) switchWindow('Status');
					renderChannelList();
				} else if (chan === activeWindow) {
					renderNickList();
					updateTopicBar();
				}
			}
			break;
		}

		case 'NICK': {
			const newNick = p[0];
			const wasMe = fromNick === nick;
			if (wasMe) nick = newNick;
			for (const chan in windows) {
				const idx = windows[chan].nicks.findIndex(function (n) {
					return n.replace(/^[~&@%+]+/, '') === fromNick;
				});
				if (idx !== -1) {
					const old = windows[chan].nicks[idx];
					const bare = old.replace(/^[~&@%+]+/, '');
					const pfx = old.slice(0, old.length - bare.length);
					windows[chan].nicks[idx] = pfx + newNick;
					addMessage(chan, chatNick('--', '#888') + '<span style="color:#888">' + esc(fromNick) +
						' is now known as ' + esc(newNick) + '</span>', timestamp);
				}
			}
			if (windows[fromNick]) {
				windows[newNick] = windows[fromNick];
				delete windows[fromNick];
				if (activeWindow === fromNick) activeWindow = newNick;
				renderChannelList();
			}
			if (activeWindow && windows[activeWindow]) renderNickList();
			if (wasMe) {
				updateInputNick();
				updateStatusBar();
			}
			break;
		}

		case 'MODE': {
			const target = p[0];
			const modeStr = p.slice(1).join(' ');
			if (target[0] === '#' || target[0] === '&') {
				addMessage(target, chatNick('--', '#888') + '<span style="color:#888">' + esc(fromNick) +
					' sets mode ' + esc(modeStr) + '</span>', timestamp);
				if (windows[target]) windows[target].nicks = [];
				send('NAMES ' + target);
				send('MODE ' + target);
			} else {
				addMessage('Status', chatNick('--', '#888') + '<span style="color:#888">Mode ' + esc(modeStr) + '</span>', timestamp);
			}
			break;
		}

		case 'TOPIC': {
			const chan = p[0];
			channelTopics[chan] = p[1] || '';
			if (windows[chan]) {
				addMessage(chan, chatNick('--', '#888') + '<span style="color:#888">' + esc(fromNick) +
					' changed topic to: ' + formatIRC(p[1] || '') + '</span>', timestamp);
			}
			if (chan === activeWindow) updateTopicBar();
			break;
		}

		case 'PRIVMSG': {
			const target = p[0];
			const text = p[1] || '';
			const isAction = text.indexOf('\x01ACTION ') === 0 && text[text.length - 1] === '\x01';
			const isChan = target[0] === '#' || target[0] === '&';
			const wn = isChan ? target : fromNick;

			if (!windows[wn]) createWindow(wn);

			if (isChan) {
				const plain = stripIRC(text).toLowerCase();
				if (plain.indexOf(nick.toLowerCase()) !== -1) {
					markActivity(wn, true, true);
					playNotificationSound();
					sendDesktopNotification(fromNick + ' in ' + wn, stripIRC(text));
					// Log to Hilights window
					const pfx = getNickPrefix(wn, fromNick);
					const nc = getNickColor(fromNick);
					const hlText = isAction ? text.slice(8, -1) : text;
					const hlNick = isAction
						? '<span style="color:' + nc + '">* ' + esc(pfx + fromNick) + '</span> '
						: '<span style="color:' + nc + '">&lt;' + esc(pfx + fromNick) + '&gt;</span> ';
					addMessage('Hilights', chatNick(wn, '#0ff') + hlNick + formatIRC(hlText), timestamp);
				}
			}

			if (!isChan) {
				playNotificationSound();
				sendDesktopNotification('Message from ' + fromNick, stripIRC(isAction ? text.slice(8, -1) : text));
			}

			const nc = getNickColor(fromNick);
			if (isAction) {
				const at = text.slice(8, -1);
				addMessage(wn, chatNick('*', nc) + '<span style="color:' + nc + '">' + esc(fromNick) + ' ' + formatIRC(at) + '</span>', timestamp, true);
			} else {
				addMessage(wn, chatNick(fromNick, nc) + formatIRC(text), timestamp, true);
			}
			break;
		}

		case 'NOTICE': {
			const target = p[0];
			const text = p[1] || '';
			const isServer = !msg.prefix.includes('!');
			const isChan = target[0] === '#' || target[0] === '&';

			if (isServer) {
				addMessage('Status', chatNick(fromNick || '***', '#ff0') + '<span style="color:#ff0">' + formatIRC(text) + '</span>', timestamp);
			} else if (isChan) {
				if (!windows[target]) createWindow(target);
				addMessage(target, chatNick(fromNick, '#ff0') + '<span style="color:#ff0">' + formatIRC(text) + '</span>', timestamp, true);
			} else {
				const wn = windows[fromNick] ? fromNick : 'Status';
				addMessage(wn, chatNick(fromNick, '#ff0') + '<span style="color:#ff0">' + formatIRC(text) + '</span>', timestamp, true);
			}
			break;
		}

		case '321':
			// RPL_LISTSTART
			if (!windows[LIST_WINDOW] || !windows[LIST_WINDOW].listView) openListWindow(LIST_WINDOW, null, false);
			setListChannels(LIST_WINDOW, [], false);
			break;

		case '322': {
			// RPL_LIST - channel info
			if (!windows[LIST_WINDOW] || !windows[LIST_WINDOW].listView) openListWindow(LIST_WINDOW, null, false);
			const topic = p[3] || '';
			windows[LIST_WINDOW].listView.channels.push({ name: p[1], users: parseInt(p[2], 10) || 0, topicHtml: formatIRC(topic), plain: stripIRC(topic) });
			scheduleListRender();
			break;
		}

		case '323':
			// RPL_LISTEND
			if (windows[LIST_WINDOW] && windows[LIST_WINDOW].listView) setListChannels(LIST_WINDOW, windows[LIST_WINDOW].listView.channels, true);
			break;

		case 'ERROR':
			addMessage('Status', chatNick('!!!', '#f00') + '<span style="color:#f00">' + formatIRC(p[0] || '') + '</span>', timestamp);
			break;

		case '433':
			nick = nick + '_';
			send('NICK ' + nick);
			addMessage('Status', chatNick('!!!', '#f00') + '<span style="color:#f00">Nick in use, trying ' + esc(nick) + '</span>', timestamp);
			updateInputNick();
			break;

		case '401': case '402': case '403': case '404': case '405':
		case '421': case '432': case '441': case '442':
		case '461': case '462': case '471': case '473': case '474': case '475':
			addMessage(activeWindow, chatNick('!!!', '#f00') + '<span style="color:#f00">' + esc(p.slice(1).join(' ')) + '</span>', timestamp);
			break;

		default:
			if (/^\d{3}$/.test(command)) {
				addMessage('Status', chatNick('***', '#888') + '<span style="color:#888">' + esc(p.slice(1).join(' ')) + '</span>', timestamp);
			}
			break;
		}
	}

	// ============================================================
	//  Connection
	// ============================================================
	// --- Get a nick's prefix in a channel ---
	function getNickPrefix(chan, target) {
		const win = windows[chan];
		if (!win || !win.nicks.length) return '';
		for (let i = 0; i < win.nicks.length; i++) {
			const bare = win.nicks[i].replace(/^[~&@%+]+/, '');
			if (bare === target) {
				return win.nicks[i].slice(0, win.nicks[i].length - bare.length);
			}
		}
		return '';
	}

	function connect() {
		createWindow('Status');
		createWindow('Hilights');
		switchWindow('Status');
		
		const protocol = useSSL ? 'wss://' : 'ws://';
		const serverURL = protocol + serverHost + ':' + serverPort;
		addMessage('Status', chatNick('***', '#888') + '<span style="color:#888">Connecting to ' + esc(serverURL) + ' ...</span>');

		ws = new WebSocket(serverURL);

		ws.onopen = function () {
			addMessage('Status', chatNick('***', '#0f0') + '<span style="color:#0f0">WebSocket connected, negotiating...</span>');
			send('CAP LS 302');
			send('NICK ' + nick);
			send('USER webchat 0 * :SuperChat IRC Gateway');
		};

		ws.onmessage = function (event) {
			const lines = event.data.split(/\r?\n/).filter(Boolean);
			lines.forEach(function (line) {
				handleMessage(parseMessage(line));
			});
		};

		ws.onclose = function () {
			addMessage('Status', chatNick('!!!', '#f00') + '<span style="color:#f00">Disconnected. Reconnecting in 15 seconds...</span>');
			registered = false;
			updateStatusBar();
			
			// Clear any existing reconnect timer
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
			
			// Attempt to reconnect after 15 seconds
			reconnectTimer = setTimeout(function () {
				addMessage('Status', chatNick('***', '#888') + '<span style="color:#888">Attempting to reconnect...</span>');
				connect();
			}, 15000);
		};

		ws.onerror = function () {
			addMessage('Status', chatNick('!!!', '#f00') + '<span style="color:#f00">WebSocket error.</span>');
		};
	}

	// ============================================================
	//  Cookie helpers
	// ============================================================
	function setCookie(name, value, days) {
		const d = new Date();
		d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
		document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + d.toUTCString() + ';path=/';
	}

	function getCookie(name) {
		const nameEQ = name + '=';
		const ca = document.cookie.split(';');
		for (let i = 0; i < ca.length; i++) {
			let c = ca[i];
			while (c.charAt(0) === ' ') c = c.substring(1, c.length);
			if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length));
		}
		return null;
	}

	function deleteCookie(name) {
		document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/';
	}

	// ============================================================
	//  Login
	// ============================================================
	function loginMode() {
		return document.querySelector('input[name="login-mode"]:checked').value;
	}

	function setLoginMode(mode) {
		document.querySelector('input[name="login-mode"][value="' + mode + '"]').checked = true;
		loginIrcEl.classList.toggle('hidden', mode !== 'irc');
		loginWcEl.classList.toggle('hidden', mode !== 'weechat');
	}

	function doWeeChatLogin() {
		const host = loginWcServerEl.value.trim();
		const port = parseInt(loginWcPortEl.value, 10);
		const tls = loginWcTLSEl.checked;

		if (!host) {
			alert('Please enter a relay host.');
			return;
		}
		if (!port || port < 1 || port > 65535) {
			alert('Please enter a valid port (1-65535).');
			return;
		}
		if (!loginWcPassEl.value) {
			alert('Please enter the relay password.');
			return;
		}

		// Save to cookies if remember is checked (never the password)
		if (loginRememberEl.checked) {
			setCookie('sc_mode', 'weechat', 365);
			setCookie('wc_server', host, 365);
			setCookie('wc_port', port, 365);
			setCookie('wc_tls', tls ? '1' : '0', 365);
		} else {
			deleteCookie('sc_mode');
			deleteCookie('wc_server');
			deleteCookie('wc_port');
			deleteCookie('wc_tls');
		}

		wcMode = true;
		requestNotificationPermission();
		WeeChat.connect({ host: host, port: port, tls: tls, password: loginWcPassEl.value, totp: loginWcTotpEl.value.trim() });
	}

	function doLogin() {
		if (loginMode() === 'weechat') return doWeeChatLogin();
		wcMode = false;

		// Get form values
		serverHost = loginServerEl.value.trim();
		serverPort = parseInt(loginPortEl.value, 10);
		useSSL = loginSSLEl.checked;
		let n = loginNickEl.value.trim();
		const channelsInput = loginChannelsEl.value.trim();
		
		// Validate server
		if (!serverHost) {
			alert('Please enter a server address.');
			return;
		}
		
		// Validate port
		if (!serverPort || serverPort < 1 || serverPort > 65535) {
			alert('Please enter a valid port (1-65535).');
			return;
		}
		
		// Validate and clean nick
		n = n.replace(/[^a-zA-Z0-9_\-\[\]]/g, '');
		n = n.substring(0, 20);
		if (n && /^[0-9]/.test(n)) {
			alert('Nickname cannot start with a number. Please choose a different nickname.');
			return;
		}
		if (!n) n = 'WebUser' + Math.floor(Math.random() * 99999);
		nick = n;
		
		// Parse channels
		autoJoinChannels = channelsInput.split(',')
			.map(function(ch) { return ch.trim(); })
			.filter(function(ch) { return ch.length > 0; });
		
		// Save to cookies if remember is checked
		if (loginRememberEl.checked) {
			setCookie('sc_mode', 'irc', 365);
			setCookie('irc_server', serverHost, 365);
			setCookie('irc_port', serverPort, 365);
			setCookie('irc_ssl', useSSL ? '1' : '0', 365);
			setCookie('irc_nick', nick, 365);
			setCookie('irc_channels', channelsInput, 365);
		} else {
			// Clear cookies if unchecked
			deleteCookie('sc_mode');
			deleteCookie('irc_server');
			deleteCookie('irc_port');
			deleteCookie('irc_ssl');
			deleteCookie('irc_nick');
			deleteCookie('irc_channels');
		}
		
		loginEl.classList.add('hidden');
		appEl.classList.remove('hidden');
		requestNotificationPermission();
		inputEl.focus();
		connect();
	}

	// Load saved settings from cookies
	function loadSavedSettings() {
		const savedServer = getCookie('irc_server');
		const savedPort = getCookie('irc_port');
		const savedSSL = getCookie('irc_ssl');
		const savedNick = getCookie('irc_nick');
		const savedChannels = getCookie('irc_channels');
		
		if (savedServer) {
			loginServerEl.value = savedServer;
			loginRememberEl.checked = true;
		}
		if (savedPort) {
			loginPortEl.value = savedPort;
		}
		if (savedSSL !== null) {
			loginSSLEl.checked = savedSSL === '1';
		}
		if (savedNick) {
			loginNickEl.value = savedNick;
		}
		if (savedChannels) {
			loginChannelsEl.value = savedChannels;
		}

		const savedWcServer = getCookie('wc_server');
		const savedWcPort = getCookie('wc_port');
		const savedWcTLS = getCookie('wc_tls');

		if (savedWcServer) {
			loginWcServerEl.value = savedWcServer;
			loginRememberEl.checked = true;
		}
		if (savedWcPort) {
			loginWcPortEl.value = savedWcPort;
		}
		if (savedWcTLS !== null) {
			loginWcTLSEl.checked = savedWcTLS === '1';
		}
		if (getCookie('sc_mode') === 'weechat') {
			setLoginMode('weechat');
		}
	}

	// WeeChat relay setup guide
	const wcGuideEl = document.getElementById('wc-guide');
	document.getElementById('login-wc-help').addEventListener('click', function () { wcGuideEl.classList.remove('hidden'); });
	document.getElementById('wc-guide-close').addEventListener('click', function () { wcGuideEl.classList.add('hidden'); });
	wcGuideEl.addEventListener('click', function (e) { if (e.target === wcGuideEl) wcGuideEl.classList.add('hidden'); });
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape') wcGuideEl.classList.add('hidden'); });

	// Login form grows with the window on desktop (to ~90% of the height or width), never past the logo's native size
	const loginBoxEl  = document.getElementById('login-box');
	const loginLogoEl = document.getElementById('login-logo');

	// Natural size of the (taller) IRC form, measured on a hidden copy so both modes get the same size
	function ircFormSize() {
		const copy = loginBoxEl.cloneNode(true);
		copy.querySelectorAll('[name]').forEach(function (el) { el.removeAttribute('name'); });
		copy.querySelector('#login-irc').classList.remove('hidden');
		copy.querySelector('#login-weechat').classList.add('hidden');
		copy.style.cssText = 'position:absolute;visibility:hidden;zoom:1;left:0;top:0';
		document.body.appendChild(copy);
		const size = { w: copy.offsetWidth, h: copy.offsetHeight };
		copy.remove();
		return size;
	}

	function scaleLogin() {
		if (loginEl.classList.contains('hidden')) return;
		loginBoxEl.style.zoom = 1;
		let scale = 1;
		if (window.innerWidth > 600 && loginBoxEl.offsetHeight) {
			const irc = ircFormSize();
			const h = Math.max(irc.h, loginBoxEl.offsetHeight);
			const w = Math.max(irc.w, loginBoxEl.offsetWidth);
			const logoMax = loginLogoEl.naturalWidth && loginLogoEl.offsetWidth ? loginLogoEl.naturalWidth / loginLogoEl.offsetWidth : 1;
			scale = Math.max(1, Math.min(window.innerHeight * 0.9 / h, window.innerWidth * 0.9 / w, logoMax));
		}
		loginBoxEl.style.zoom = scale;
	}

	window.addEventListener('resize', scaleLogin);
	loginLogoEl.addEventListener('load', scaleLogin);
	document.fonts.ready.then(scaleLogin);
	scaleLogin();
	// Re-fit when the form's content changes (mode switch, TOTP field, error text) or the login screen reappears
	new MutationObserver(scaleLogin).observe(loginEl, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true });

	// Load saved settings on page load
	loadSavedSettings();

	loginBtnEl.addEventListener('click', doLogin);
	loginNickEl.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') doLogin();
	});
	loginChannelsEl.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') doLogin();
	});
	loginWcPassEl.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') doLogin();
	});
	loginWcTotpEl.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') doLogin();
	});
	[loginPortEl, loginWcPortEl].forEach(function (el) {
		el.addEventListener('input', function () { el.value = el.value.replace(/\D/g, ''); });
	});
	document.querySelectorAll('input[name="login-mode"]').forEach(function (r) {
		r.addEventListener('change', function () { setLoginMode(r.value); });
	});

	// ============================================================
	//  Toggle buttons
	// ============================================================
	// Set initial toggle state
	toggleChanBtn.classList.toggle('active', showChanlist);
	toggleNickBtn.classList.toggle('active', showNicklist);
	updateChanlistVisibility();

	toggleChanBtn.addEventListener('click', function () {
		showChanlist = !showChanlist;
		toggleChanBtn.classList.toggle('active', showChanlist);
		updateChanlistVisibility();
		messagesEl.scrollTop = messagesEl.scrollHeight;
	});

	toggleNickBtn.addEventListener('click', function () {
		showNicklist = !showNicklist;
		toggleNickBtn.classList.toggle('active', showNicklist);
		updateNicklistVisibility();
		messagesEl.scrollTop = messagesEl.scrollHeight;
	});

	// ============================================================
	//  Resizable side panels (widths remembered in localStorage)
	// ============================================================
	function setPanelWidth(panel, w) {
		w = Math.round(Math.max(80, Math.min(w, window.innerWidth * 0.4)));
		panel.style.width = panel.style.minWidth = w + 'px';
	}

	function makeResizable(handle, panel, dir, key) {
		try {
			const saved = parseInt(localStorage.getItem(key), 10);
			if (saved) setPanelWidth(panel, saved);
		} catch (e) { /* storage unavailable */ }

		handle.addEventListener('pointerdown', function (e) {
			e.preventDefault();
			handle.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const startW = panel.offsetWidth;
			function move(ev) {
				setPanelWidth(panel, startW + (ev.clientX - startX) * dir);
			}
			function up() {
				handle.removeEventListener('pointermove', move);
				handle.removeEventListener('pointerup', up);
				handle.removeEventListener('pointercancel', up);
				try { localStorage.setItem(key, panel.offsetWidth); } catch (err) { /* storage unavailable */ }
			}
			handle.addEventListener('pointermove', move);
			handle.addEventListener('pointerup', up);
			handle.addEventListener('pointercancel', up);
		});
	}

	makeResizable(document.getElementById('resize-channels'), channelsEl, 1, 'sc_chanlist_width');
	makeResizable(document.getElementById('resize-nicklist'), nicklistEl, -1, 'sc_nicklist_width');

	// ============================================================
	//  Nick column width: drag the separator line (remembered in localStorage)
	// ============================================================
	function setNickCol(n) {
		n = Math.max(NICK_COL_MIN, Math.min(NICK_COL_MAX, n));
		messagesEl.style.setProperty('--nick-col', n);
		return n;
	}

	// Separator x position and width of one character, measured from a rendered line
	function nickColGeometry() {
		const line = messagesEl.querySelector('.line');
		const col = line && line.querySelector('.nick-col');
		if (!col) return null;
		const n = parseInt(getComputedStyle(messagesEl).getPropertyValue('--nick-col'), 10);
		return {
			x: line.getBoundingClientRect().left + parseFloat(getComputedStyle(line, '::after').left),
			ch: col.getBoundingClientRect().width / n,
			n: n
		};
	}

	function nearSeparator(e) {
		const g = nickColGeometry();
		return g && Math.abs(e.clientX - g.x) <= (e.pointerType === 'touch' ? 10 : 4) ? g : null;
	}

	try {
		const savedNickCol = parseInt(localStorage.getItem('sc_nick_col'), 10);
		if (savedNickCol) setNickCol(savedNickCol);
	} catch (e) { /* storage unavailable */ }

	messagesEl.addEventListener('pointermove', function (e) {
		if (e.buttons) return;
		messagesEl.style.cursor = nearSeparator(e) ? 'col-resize' : '';
	});

	messagesEl.addEventListener('pointerdown', function (e) {
		const g = nearSeparator(e);
		if (!g) return;
		e.preventDefault();
		messagesEl.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		let n = g.n;
		function move(ev) {
			n = setNickCol(g.n + Math.round((ev.clientX - startX) / g.ch));
		}
		function up() {
			messagesEl.removeEventListener('pointermove', move);
			messagesEl.removeEventListener('pointerup', up);
			messagesEl.removeEventListener('pointercancel', up);
			try { localStorage.setItem('sc_nick_col', n); } catch (err) { /* storage unavailable */ }
		}
		messagesEl.addEventListener('pointermove', move);
		messagesEl.addEventListener('pointerup', up);
		messagesEl.addEventListener('pointercancel', up);
	});

	// Font size adjustment: multiples of 4 keep Fairfax HD cells on whole pixels (0.5em wide, 0.75em baseline)
	function updateFontSize() {
		messagesEl.style.fontSize = fontSize + 'px';
		messagesEl.scrollTop = messagesEl.scrollHeight;
		try { localStorage.setItem('sc_font_size', fontSize); } catch (e) { /* storage unavailable */ }
	}

	try {
		const savedFontSize = parseInt(localStorage.getItem('sc_font_size'), 10);
		if (savedFontSize >= 8 && savedFontSize <= 20 && savedFontSize % 4 === 0) fontSize = savedFontSize;
	} catch (e) { /* storage unavailable */ }
	messagesEl.style.fontSize = fontSize + 'px';

	fontDecBtn.addEventListener('click', function () {
		if (fontSize > 8) {
			fontSize -= 4;
			updateFontSize();
		}
	});

	fontIncBtn.addEventListener('click', function () {
		if (fontSize < 20) {
			fontSize += 4;
			updateFontSize();
		}
	});

	// ============================================================
	//  Copy handler — flatten wrapped lines so each message = one clipboard line
	// ============================================================
	messagesEl.addEventListener('copy', function (e) {
		const selection = window.getSelection();
		if (!selection.rangeCount) return;

		var lines = messagesEl.querySelectorAll('.line');
		var hasFullLine = false;
		var copiedLines = [];
		for (var i = 0; i < lines.length; i++) {
			if (selection.containsNode(lines[i], false)) {
				hasFullLine = true;
				copiedLines.push(lines[i].textContent.trim());
			} else if (selection.containsNode(lines[i], true)) {
				copiedLines.push(lines[i].textContent.trim());
			}
		}

		if (!hasFullLine || copiedLines.length === 0) return;

		e.preventDefault();
		e.clipboardData.setData('text/plain', copiedLines.join('\n'));
	});

	// ============================================================
	//  Input handling
	// ============================================================
	function processInput(text) {
		if (!text) return;

		commandHistory.unshift(toMarkers(text));
		if (commandHistory.length > 100) commandHistory.pop();
		text = toCodes(text);

		if (windows[activeWindow] && windows[activeWindow].listView && /^\/close(\s|$)/i.test(text)) {
			closeListWindow();
			return;
		}

		if (wcMode && /^\/list(\s|$)/i.test(text)) {
			WeeChat.list(text.substring(5).trim());
			return;
		}

		if (wcMode && !/^\/clear(\s|$)/i.test(text)) {
			WeeChat.input(activeWindow, text);
			return;
		}

		if (text[0] === '/') {
			const spaceIdx = text.indexOf(' ');
			const cmd = (spaceIdx === -1 ? text.substring(1) : text.substring(1, spaceIdx)).toLowerCase();
			const argStr = spaceIdx === -1 ? '' : text.substring(spaceIdx + 1);
			const args = argStr ? argStr.split(' ') : [];

			switch (cmd) {
			case 'join':
				if (args[0]) send('JOIN ' + args[0] + (args[1] ? ' ' + args[1] : ''));
				break;

			case 'part': {
				const chan = args[0] || (activeWindow !== 'Status' ? activeWindow : '');
				if (chan) send('PART ' + chan + (args.length > 1 ? ' :' + args.slice(1).join(' ') : ''));
				break;
			}

			case 'msg': case 'privmsg': {
				if (args.length >= 2) {
					const tgt = args[0];
					const m = args.slice(1).join(' ');
					send('PRIVMSG ' + tgt + ' :' + m);
					if (!windows[tgt]) createWindow(tgt);
					addMessage(tgt, chatNick(nick, getNickColor(nick)) + formatIRC(m));
				}
				break;
			}

			case 'notice': {
				if (args.length >= 2) {
					const tgt = args[0];
					const m = args.slice(1).join(' ');
					send('NOTICE ' + tgt + ' :' + m);
					addMessage(activeWindow, chatNick(nick, '#ff0') + '<span style="color:#ff0">\u2192 ' + esc(tgt) + ': ' + formatIRC(m) + '</span>');
				}
				break;
			}

			case 'nick':
				if (args[0]) send('NICK ' + args[0]);
				break;

			case 'quit':
				send('QUIT :' + (argStr || 'Leaving'));
				break;

			case 'me':
				if (activeWindow !== 'Status') {
					send('PRIVMSG ' + activeWindow + ' :\x01ACTION ' + argStr + '\x01');
					const nc = getNickColor(nick);
					addMessage(activeWindow, chatNick('*', nc) + '<span style="color:' + nc + '">' + esc(nick) + ' ' + formatIRC(argStr) + '</span>');
				}
				break;

			case 'topic':
				if (activeWindow !== 'Status') {
					if (argStr) send('TOPIC ' + activeWindow + ' :' + argStr);
					else send('TOPIC ' + activeWindow);
				}
				break;

			case 'query':
				if (args[0]) {
					if (!windows[args[0]]) createWindow(args[0]);
					switchWindow(args[0]);
				}
				break;

			case 'close':
				if (activeWindow !== 'Status' && activeWindow !== 'Hilights') {
					const w = activeWindow;
					if (w[0] === '#' || w[0] === '&') send('PART ' + w);
					delete windows[w];
					delete channelModes[w];
					delete channelTopics[w];
					delete historyLoaded[w];
					switchWindow('Status');
					renderChannelList();
				}
				break;

			case 'clear':
				if (windows[activeWindow]) {
					windows[activeWindow].messages = [];
					renderMessages();
				}
				break;

			case 'raw': case 'quote':
				if (argStr) send(argStr);
				break;

			case 'list':
				openListWindow(LIST_WINDOW, null, true);
				send('LIST' + (argStr ? ' ' + argStr : ''));
				break;

			default:
				send(text.substring(1));
				break;
			}
		} else {
			if (activeWindow !== 'Status' && !windows[activeWindow].listView) {
				send('PRIVMSG ' + activeWindow + ' :' + text);
				addMessage(activeWindow, chatNick(nick, getNickColor(nick)) + formatIRC(text));
			}
		}
	}

	inputEl.addEventListener('keydown', function (e) {
		if (e.key === 'ArrowUp') {
			if (commandHistory.length) {
				if (historyIndex < commandHistory.length - 1) historyIndex++;
				inputEl.value = commandHistory[historyIndex];
				updateInputPreview();
			}
			e.preventDefault();
			return;
		}
		if (e.key === 'ArrowDown') {
			if (historyIndex > 0) {
				historyIndex--;
				inputEl.value = commandHistory[historyIndex];
			} else {
				historyIndex = -1;
				inputEl.value = '';
			}
			updateInputPreview();
			e.preventDefault();
			return;
		}
		if (e.key === 'Tab') {
			e.preventDefault();
			if (wcMode) WeeChat.complete(inputEl);
			else tabComplete();
			return;
		}
		if (e.key !== 'Enter') return;

		const text = inputEl.value;
		inputEl.value = '';
		updateInputPreview();
		historyIndex = -1;
		processInput(text);
	});

	inputEl.addEventListener('paste', function (e) {
		var cbd = e.clipboardData || window.clipboardData;
		var clip = cbd.getData('text/plain') || cbd.getData('text') || '';
		var lines = clip.split(/\r?\n/);
		if (lines.length <= 1) return;

		e.preventDefault();
		for (var i = 0; i < lines.length; i++) {
			if (lines[i]) processInput(lines[i]);
		}
	});

	// ============================================================
	//  Channel list view (/list): searchable, sortable, tap a row to join
	// ============================================================
	const LIST_WINDOW = 'Channel list';
	let listSort = { key: 'users', dir: -1 };
	let listRenderTimer = null;
	let pendingListJoin = null;

	// channels: [{ name, users, topicHtml, plain }]
	function openListWindow(key, server, show) {
		const from = activeWindow;
		if (!windows[key]) windows[key] = { messages: [], nicks: [], unread: 0, mentioned: false, label: 'Channel list' };
		windows[key].vars = { type: 'list', server: server };
		windows[key].listView = { channels: [], loading: true, error: '', server: server, returnTo: from };
		if (show) {
			listSearchEl.value = '';
			switchWindow(key);
		} else {
			renderChannelList();
		}
	}

	function setListChannels(key, channels, done, error) {
		const win = windows[key];
		if (!win || !win.listView) return;
		win.listView.channels = channels;
		win.listView.loading = !done;
		win.listView.error = error || '';
		if (activeWindow === key) renderListView();
	}

	function scheduleListRender() {
		if (listRenderTimer) return;
		listRenderTimer = setTimeout(function () {
			listRenderTimer = null;
			if (windows[activeWindow] && windows[activeWindow].listView) renderListView();
		}, 300);
	}

	function closeListWindow() {
		const win = windows[activeWindow];
		if (!win || !win.listView) return;
		const lv = win.listView;
		if (wcMode) WeeChat.closeList(lv.server);
		delete windows[activeWindow];
		switchWindow(windows[lv.returnTo] ? lv.returnTo : Object.keys(windows)[0]);
	}

	function updateListView() {
		const isList = !!(windows[activeWindow] && windows[activeWindow].listView);
		listviewEl.classList.toggle('hidden', !isList);
		messagesEl.classList.toggle('hidden', isList);
		if (isList) renderListView();
	}

	function renderListView() {
		const lv = windows[activeWindow].listView;
		const q = listSearchEl.value.trim().toLowerCase();
		const rows = lv.channels.filter(function (c) {
			return !q || c.name.toLowerCase().indexOf(q) !== -1 || c.plain.toLowerCase().indexOf(q) !== -1;
		});
		rows.sort(function (a, b) {
			const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
			return listSort.key === 'name' ? byName * listSort.dir : ((a.users - b.users) * listSort.dir || byName);
		});

		listviewEl.querySelectorAll('[data-sort]').forEach(function (b) {
			const active = b.dataset.sort === listSort.key;
			b.classList.toggle('active', active);
			b.textContent = (b.dataset.sort === 'name' ? 'Name' : 'Users') + (active ? (listSort.dir > 0 ? ' \u25B2' : ' \u25BC') : '');
		});

		if (lv.error) listStatusEl.textContent = lv.error;
		else if (lv.loading) listStatusEl.textContent = 'Loading channel list... ' + (lv.channels.length ? lv.channels.length + ' so far' : '');
		else listStatusEl.textContent = (q ? rows.length + ' of ' : '') + lv.channels.length + ' channels \u2014 tap a channel to join';

		let nameW = 6;
		rows.forEach(function (c) { nameW = Math.max(nameW, c.name.length); });
		listRowsEl.style.setProperty('--name-w', Math.min(nameW, 30));

		const frag = document.createDocumentFragment();
		rows.forEach(function (c) {
			const row = document.createElement('div');
			row.className = 'listrow';
			row.innerHTML = '<span class="lr-name" title="' + esc(c.name) + '">' + esc(c.name) + '</span>' +
				'<span class="lr-users">' + c.users + '</span>' +
				'<span class="lr-topic" title="' + esc(c.plain) + '">' + c.topicHtml + '</span>';
			row.addEventListener('click', function (e) {
				if (e.target.closest('a')) return;
				joinFromList(c.name);
			});
			frag.appendChild(row);
		});
		listRowsEl.innerHTML = '';
		listRowsEl.appendChild(frag);
	}

	function joinFromList(name) {
		const lv = windows[activeWindow].listView;
		if (wcMode) return WeeChat.join(lv.server, name);
		if (windows[name]) return switchWindow(name);
		pendingListJoin = name.toLowerCase();
		send('JOIN ' + name);
	}

	listSearchEl.addEventListener('input', function () {
		if (windows[activeWindow] && windows[activeWindow].listView) renderListView();
	});

	listviewEl.querySelectorAll('[data-sort]').forEach(function (b) {
		b.addEventListener('click', function () {
			if (listSort.key === b.dataset.sort) listSort.dir = -listSort.dir;
			else listSort = { key: b.dataset.sort, dir: b.dataset.sort === 'name' ? 1 : -1 };
			renderListView();
		});
	});

	document.getElementById('listview-refresh').addEventListener('click', function () {
		const lv = windows[activeWindow].listView;
		if (wcMode) return WeeChat.list('', lv.server);
		openListWindow(LIST_WINDOW, null, true);
		send('LIST');
	});

	document.getElementById('listview-close').addEventListener('click', closeListWindow);

	// ============================================================
	//  Input formatting: control codes are shown in the input as 1-cell control
	//  pictures (U+2400 + code) and rendered live in #input-preview underneath
	// ============================================================
	function toMarkers(t) {
		return t.replace(/[\x02\x03\x0F\x16\x1D\x1F]/g, function (c) { return String.fromCharCode(0x2400 + c.charCodeAt(0)); });
	}

	function toCodes(t) {
		return t.replace(/[\u2402\u2403\u240F\u2416\u241D\u241F]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x2400); });
	}

	function previewHtml(v) {
		let out = '';
		let run = '';
		let bold = false, italic = false, underline = false, fg = null, bg = null;

		function flush() {
			if (!run) return;
			const s = [];
			if (bold)      s.push('font-weight:bold');
			if (italic)    s.push('font-style:italic');
			if (underline) s.push('text-decoration:underline');
			if (fg !== null && IRC_COLORS[fg]) s.push('color:' + IRC_COLORS[fg]);
			if (bg !== null && IRC_COLORS[bg]) s.push('background-color:' + IRC_COLORS[bg]);
			out += s.length ? '<span style="' + s.join(';') + '">' + esc(run) + '</span>' : esc(run);
			run = '';
		}

		let i = 0;
		while (i < v.length) {
			const c = v[i];
			let code = '';
			if (c === '\u2403') {
				const m = /^\u2403(?:(\d{1,2})(?:,(\d{1,2}))?)?/.exec(v.substring(i));
				code = m[0];
				flush();
				if (m[1] !== undefined) {
					fg = parseInt(m[1], 10);
					if (m[2] !== undefined) bg = parseInt(m[2], 10);
				} else {
					fg = bg = null;
				}
			} else if (c === '\u2402' || c === '\u241D' || c === '\u241F' || c === '\u2416' || c === '\u240F') {
				code = c;
				flush();
				if (c === '\u2402') bold = !bold;
				else if (c === '\u241D') italic = !italic;
				else if (c === '\u241F') underline = !underline;
				else if (c === '\u2416') { const t = fg; fg = bg; bg = t; }
				else { bold = italic = underline = false; fg = bg = null; }
			}
			if (code) {
				out += '<span class="code">' + esc(code) + '</span>';
				i += code.length;
			} else {
				run += c;
				i++;
			}
		}
		flush();
		return out;
	}

	function updateInputPreview() {
		inputPreviewEl.innerHTML = previewHtml(inputEl.value) + ' ';
		inputPreviewEl.scrollLeft = inputEl.scrollLeft;
	}

	inputEl.addEventListener('input', function () {
		// Pasted/typed raw control codes become visible markers (same length, so the caret stays put)
		if (/[\x02\x03\x0F\x16\x1D\x1F]/.test(inputEl.value)) {
			const pos = inputEl.selectionStart;
			inputEl.value = toMarkers(inputEl.value);
			inputEl.setSelectionRange(pos, pos);
		}
		updateInputPreview();
	});
	['keyup', 'click', 'select', 'scroll', 'focus'].forEach(function (ev) {
		inputEl.addEventListener(ev, function () { inputPreviewEl.scrollLeft = inputEl.scrollLeft; });
	});
	inputEl.addEventListener('keydown', function () {
		requestAnimationFrame(function () { inputPreviewEl.scrollLeft = inputEl.scrollLeft; });
	});

	// --- Format popover ---
	let formatTab = 'fg';
	let formatMore = false;
	let formatPos = 0;

	function buildSwatches() {
		formatColorsEl.innerHTML = '';
		const count = formatMore ? IRC_COLORS.length : 16;
		for (let c = 0; c < count; c++) {
			const b = document.createElement('button');
			b.type = 'button';
			b.title = String(c);
			b.style.background = IRC_COLORS[c];
			b.addEventListener('click', function () { pickColor(c); });
			formatColorsEl.appendChild(b);
		}
		formatMoreBtn.textContent = formatMore ? 'Fewer colors' : 'More colors';
	}

	function openFormat() {
		formatPos = inputEl.selectionEnd !== null ? inputEl.selectionEnd : inputEl.value.length;
		formatPopEl.classList.remove('hidden');
		formatBtn.classList.add('active');
		const r = formatBtn.getBoundingClientRect();
		const w = formatPopEl.offsetWidth;
		formatPopEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
		formatPopEl.style.bottom = (window.innerHeight - r.top + 4) + 'px';
	}

	function closeFormat() {
		formatPopEl.classList.add('hidden');
		formatBtn.classList.remove('active');
	}

	function insertFormat(str) {
		const v = inputEl.value;
		const pos = Math.min(formatPos, v.length);
		inputEl.value = v.substring(0, pos) + str + v.substring(pos);
		closeFormat();
		inputEl.focus();
		inputEl.setSelectionRange(pos + str.length, pos + str.length);
		updateInputPreview();
	}

	function pad2(n) {
		return ('0' + n).slice(-2);
	}

	function pickColor(c) {
		if (formatTab === 'fg') return insertFormat('\u2403' + pad2(c));
		// mIRC needs a text color before a background: extend a color code right before the cursor, else use 99 (default)
		const before = inputEl.value.substring(0, formatPos);
		insertFormat(/\u2403\d{1,2}$/.test(before) ? ',' + pad2(c) : '\u240399,' + pad2(c));
	}

	formatBtn.addEventListener('click', function () {
		if (formatPopEl.classList.contains('hidden')) openFormat();
		else closeFormat();
	});

	// Keep focus (and the mobile keyboard) on the input while using the popover
	[formatBtn, formatPopEl].forEach(function (el) {
		el.addEventListener('mousedown', function (e) { e.preventDefault(); });
	});

	formatPopEl.querySelectorAll('[data-insert]').forEach(function (b) {
		b.addEventListener('click', function () {
			insertFormat({ bold: '\u2402', underline: '\u241F', reset: '\u240F' }[b.dataset.insert]);
		});
	});

	formatPopEl.querySelectorAll('[data-tab]').forEach(function (b) {
		b.addEventListener('click', function () {
			formatTab = b.dataset.tab;
			formatPopEl.querySelectorAll('[data-tab]').forEach(function (t) { t.classList.toggle('active', t === b); });
		});
	});

	formatMoreBtn.addEventListener('click', function () {
		formatMore = !formatMore;
		buildSwatches();
		if (!formatPopEl.classList.contains('hidden')) openFormat();
	});

	document.addEventListener('pointerdown', function (e) {
		if (!formatPopEl.classList.contains('hidden') && !formatPopEl.contains(e.target) && !formatBtn.contains(e.target)) closeFormat();
	});

	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape') closeFormat();
	});

	buildSwatches();

	// --- Tab completion for nicks ---
	function tabComplete() {
		const val = inputEl.value;
		const cursorPos = inputEl.selectionStart;
		const before = val.substring(0, cursorPos);
		const after = val.substring(cursorPos);
		const words = before.split(' ');
		const partial = words[words.length - 1].toLowerCase();
		if (!partial) return;

		const win = windows[activeWindow];
		if (!win || !win.nicks.length) return;

		const match = win.nicks.find(function (n) {
			return n.replace(/^[~&@%+]+/, '').toLowerCase().indexOf(partial) === 0;
		});
		if (match) {
			const bare = match.replace(/^[~&@%+]+/, '');
			words[words.length - 1] = bare + (words.length === 1 ? ': ' : ' ');
			inputEl.value = words.join(' ') + after;
			updateInputPreview();
		}
	}

	// --- Internals shared with weechat.js ---
	window.SuperChat = {
		windows: windows,
		getActive: function () { return activeWindow; },
		esc: esc,
		linkify: linkify,
		stampLine: stampLine,
		addMessage: addMessage,
		appendLine: appendLine,
		switchWindow: switchWindow,
		renderMessages: renderMessages,
		renderChannelList: renderChannelList,
		markActivity: markActivity,
		renderNickList: renderNickList,
		updateTopicBar: updateTopicBar,
		updateInputNick: updateInputNick,
		updateInputPreview: updateInputPreview,
		openListWindow: openListWindow,
		setListChannels: setListChannels,
		playNotificationSound: playNotificationSound,
		sendDesktopNotification: sendDesktopNotification
	};

})();
