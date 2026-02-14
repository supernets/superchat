(function () {
	'use strict';

	const SERVER_URL = 'wss://irc.supernets.org:7000';
	const BLACKHOLE = '#blackhole';
	const AUTO_JOIN = ['#dev', '#comms', '#exchange', '#hardchats', '#scroll', '#superbowl'];
	const AUTO_JOIN_FOCUS = '#superbowl';
	const NICK_MAX = 10;

	// --- State ---
	let nick = '';
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
	let showChanlist = true;
	let showNicklist = true;
	let notificationsEnabled = false;
	let fontSize = 14;
	let reconnectTimer = null;

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
	const loginEl       = document.getElementById('login');
	const loginNickEl   = document.getElementById('login-nick');
	const loginBtnEl    = document.getElementById('login-btn');
	const appEl         = document.getElementById('app');
	const channelsEl    = document.getElementById('channels');
	const topicbarEl    = document.getElementById('topicbar');
	const messagesEl    = document.getElementById('messages');
	const nicklistEl    = document.getElementById('nicklist');
	const inputEl       = document.getElementById('input');
	const inputNickEl   = document.getElementById('input-nick');
	const toggleChanBtn = document.getElementById('toggle-chanlist');
	const toggleNickBtn = document.getElementById('toggle-nicklist');
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

	// --- Nick truncation ---
	function truncNick(n) {
		if (n.length > NICK_MAX) return n.substring(0, NICK_MAX) + '..';
		return n;
	}

	// --- Chat nick column + separator ---
	function chatNick(displayNick, color) {
		let dn = displayNick;
		if (dn.length > NICK_MAX) dn = dn.substring(0, NICK_MAX) + '..';
		return '<span class="nick-col" style="color:' + color + '" title="' + esc(displayNick) + '">' + esc(dn) + '</span> <span class="sep">\u2502</span> ';
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
		return out;
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
		renderChannelList();
		renderMessages();
		updateNicklistVisibility();
		renderNickList();
		updateInputNick();
		updateTopicBar();
		updateStatusBar();
		// Don't auto-focus input on mobile
		if (window.innerWidth > 600) {
			inputEl.focus();
		}
	}

	function addMessage(windowName, html, timestamp) {
		if (!windows[windowName]) createWindow(windowName);
		const t = timestamp ? new Date(timestamp) : new Date();
		const ts = ('0' + t.getHours()).slice(-2) + ':' +
		           ('0' + t.getMinutes()).slice(-2) + ':' +
		           ('0' + t.getSeconds()).slice(-2);
		const line = '<span class="timestamp">[' + ts + ']</span> ' + html;
		const win = windows[windowName];
		win.messages.push(line);
		if (win.messages.length > 5000) win.messages.shift();

		if (windowName === activeWindow) {
			appendLine(line);
		} else {
			win.unread++;
			renderChannelList();
		}
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
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function renderChannelList() {
		channelsEl.innerHTML = '';
		for (const name in windows) {
			const tab = document.createElement('div');
			const win = windows[name];
			let cls = 'tab';
			if (name === activeWindow) {
				cls += ' active';
			} else if (win.mentioned) {
				cls += ' mentioned';
			} else if (win.unread > 0) {
				cls += ' unread';
			}
			tab.className = cls;
			tab.textContent = name;
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
				const displayNick = truncNick(entry.bare);
				div.innerHTML = pfxHtml + esc(displayNick);
				div.title = entry.bare;
				div.ondblclick = (function (b) { return function () {
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

	// --- Get our prefix in a channel ---
	function getOurPrefix(windowName) {
		const win = windows[windowName];
		if (!win || !win.nicks.length) return '';
		for (let i = 0; i < win.nicks.length; i++) {
			const bare = win.nicks[i].replace(/^[~&@%+]+/, '');
			if (bare === nick) {
				return win.nicks[i].slice(0, win.nicks[i].length - bare.length);
			}
		}
		return '';
	}

	function updateInputNick() {
		const pfx = isChanWindow(activeWindow) ? getOurPrefix(activeWindow) : '';
		inputNickEl.textContent = pfx + nick + ':';
		inputNickEl.style.color = getNickColor(nick);
	}

	function updateTopicBar() {
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
			// Auto-join channels after end of MOTD
			setTimeout(function () {
				if (registered) {
					send('JOIN ' + AUTO_JOIN.join(','));
					// Focus the designated channel once it's joined
					const waitForFocus = setInterval(function () {
						if (windows[AUTO_JOIN_FOCUS]) {
							switchWindow(AUTO_JOIN_FOCUS);
							clearInterval(waitForFocus);
						}
					}, 200);
					// Safety: stop waiting after 15 seconds
					setTimeout(function () { clearInterval(waitForFocus); }, 15000);
				}
			}, 3000);
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

			if (fromNick === nick && chan.toLowerCase() === BLACKHOLE) {
				send('PART ' + chan);
				break;
			}

			if (fromNick === nick) {
				createWindow(chan);
				// Don't auto-switch to prevent force-join spam attacks
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
					if (wn !== activeWindow) windows[wn].mentioned = true;
					playNotificationSound();
					sendDesktopNotification(fromNick + ' in ' + wn, stripIRC(text));
					// Log to Hilights window
					const pfx = getNickPrefix(wn, fromNick);
					const nc = getNickColor(fromNick);
					const hlText = isAction ? text.slice(8, -1) : text;
					const hlNick = isAction
						? '<span style="color:' + nc + '">* ' + esc(pfx + fromNick) + '</span> '
						: '<span style="color:' + nc + '">&lt;' + esc(pfx + fromNick) + '&gt;</span> ';
					addMessage('Hilights', '<span style="color:#0ff">' + esc(wn) + '</span> <span class="sep">\u2502</span> ' + hlNick + formatIRC(hlText), timestamp);
				}
			}

			const nc = getNickColor(fromNick);
			if (isAction) {
				const at = text.slice(8, -1);
				addMessage(wn, chatNick('*', nc) + '<span style="color:' + nc + '">' + esc(fromNick) + ' ' + formatIRC(at) + '</span>', timestamp);
			} else {
				addMessage(wn, chatNick(fromNick, nc) + formatIRC(text), timestamp);
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
				addMessage(target, chatNick(fromNick, '#ff0') + '<span style="color:#ff0">' + formatIRC(text) + '</span>', timestamp);
			} else {
				const wn = windows[fromNick] ? fromNick : 'Status';
				addMessage(wn, chatNick(fromNick, '#ff0') + '<span style="color:#ff0">' + formatIRC(text) + '</span>', timestamp);
			}
			break;
		}

		case '321': {
			// RPL_LISTSTART
			addMessage('Status', chatNick('***', '#888') + '<span style="color:#888">Channel list:</span>', timestamp);
			break;
		}

		case '322': {
			// RPL_LIST - channel info
			const chan = p[1];
			const userCount = p[2] || '0';
			const topic = p[3] || '';
			addMessage('Status', chatNick('***', '#888') + 
				'<span style="color:#0ff;font-weight:bold">' + esc(chan) + '</span> ' +
				'<span style="color:#666">(' + esc(userCount) + ')</span> ' +
				(topic ? formatIRC(topic) : ''), timestamp);
			break;
		}

		case '323': {
			// RPL_LISTEND
			addMessage('Status', chatNick('***', '#888') + '<span style="color:#888">End of channel list</span>', timestamp);
			break;
		}

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
		addMessage('Status', chatNick('***', '#888') + '<span style="color:#888">Connecting to ' + esc(SERVER_URL) + ' ...</span>');

		ws = new WebSocket(SERVER_URL);

		ws.onopen = function () {
			addMessage('Status', chatNick('***', '#0f0') + '<span style="color:#0f0">WebSocket connected, negotiating...</span>');
			send('CAP LS 302');
			send('NICK ' + nick);
			send('USER webirc 0 * :https://webchat.supernets.org');
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
	//  Login
	// ============================================================
	function doLogin() {
		let n = loginNickEl.value.trim();
		// Remove invalid chars: only alphanumeric, -, _, [, ]
		n = n.replace(/[^a-zA-Z0-9_\-\[\]]/g, '');
		// Can't start with a number
		if (n && /^[0-9]/.test(n)) {
			n = 'Guest' + n;
		}
		// Limit to 20 chars
		n = n.substring(0, 20);
		if (!n) n = 'WebUser' + Math.floor(Math.random() * 99999);
		nick = n;
		loginEl.classList.add('hidden');
		appEl.classList.remove('hidden');
		requestNotificationPermission();
		inputEl.focus();
		connect();
	}

	const params = new URLSearchParams(window.location.search);
	const urlNick = params.get('nick');
	if (urlNick && urlNick.trim()) {
		let n = urlNick.trim();
		n = n.replace(/[^a-zA-Z0-9_\-\[\]]/g, '');
		if (n && /^[0-9]/.test(n)) {
			n = 'Guest' + n;
		}
		n = n.substring(0, 20);
		nick = n;
		if (nick) {
			loginEl.classList.add('hidden');
			appEl.classList.remove('hidden');
			requestNotificationPermission();
			connect();
		}
	}

	loginBtnEl.addEventListener('click', doLogin);
	loginNickEl.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') doLogin();
	});

	// ============================================================
	//  Toggle buttons
	// ============================================================
	// Set initial toggle state
	toggleChanBtn.classList.add('active');
	toggleNickBtn.classList.add('active');

	toggleChanBtn.addEventListener('click', function () {
		showChanlist = !showChanlist;
		toggleChanBtn.classList.toggle('active', showChanlist);
		updateChanlistVisibility();
	});

	toggleNickBtn.addEventListener('click', function () {
		showNicklist = !showNicklist;
		toggleNickBtn.classList.toggle('active', showNicklist);
		updateNicklistVisibility();
	});

	// Font size adjustment
	function updateFontSize() {
		messagesEl.style.fontSize = fontSize + 'px';
	}

	fontDecBtn.addEventListener('click', function () {
		if (fontSize > 10) {
			fontSize--;
			updateFontSize();
		}
	});

	fontIncBtn.addEventListener('click', function () {
		if (fontSize < 24) {
			fontSize++;
			updateFontSize();
		}
	});

	// ============================================================
	//  Input handling
	// ============================================================
	inputEl.addEventListener('keydown', function (e) {
		if (e.key === 'ArrowUp') {
			if (commandHistory.length) {
				if (historyIndex < commandHistory.length - 1) historyIndex++;
				inputEl.value = commandHistory[historyIndex];
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
			e.preventDefault();
			return;
		}
		if (e.key === 'Tab') {
			e.preventDefault();
			tabComplete();
			return;
		}
		if (e.key !== 'Enter') return;

		const text = inputEl.value;
		inputEl.value = '';
		historyIndex = -1;
		if (!text) return;

		commandHistory.unshift(text);
		if (commandHistory.length > 100) commandHistory.pop();

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
				send('LIST' + (argStr ? ' ' + argStr : ''));
				break;

			default:
				send(text.substring(1));
				break;
			}
		} else {
			if (activeWindow !== 'Status') {
				send('PRIVMSG ' + activeWindow + ' :' + text);
				addMessage(activeWindow, chatNick(nick, getNickColor(nick)) + formatIRC(text));
			}
		}
	});

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
		}
	}

})();
