# SuperCHAT

> Bare minimal websockets based IRC client

**Live Demo:** [https://webchat.supernets.org](https://webchat.supernets.org)

![Preview](.screens/preview.png)

A client-side JavaScript IRC client that connects through WebSocket gateways. No backend, no build process, no dependencies - just open it in a browser. It handles standard IRC protocol features, supports multiple channels, tracks highlights across all your conversations, and works on mobile. The interface uses monospace fonts for proper display of ASCII art and code.

## Features
- Pure client-side *(runs entirely in browser)*
- Multi-channel & private message support
- IRCv3 capabilities *(server-time, batch, message-tags, chat history)*
- Highlight tracking with audio & desktop notifications
- Full mIRC color code support for formatted text
- Mobile responsive with adjustable font sizes
- Connect to any WebSocket-enabled IRC network
- Cookie-based settings persistence
- Auto-reconnect when disconnected
- Toggle chan/nick list boxes and adjustable font size on mobile

## WebSocket Requirement

**Important:** This client requires IRC networks with WebSocket gateway support. Standard IRC ports *(6667/6697)* will not work. You need a WebSocket-enabled port, typically 7000, 8080, or similar.

## UnrealIRCd setup for Websockets

#### Create a listen block for websocket connections over TLS
```
listen {
    ip *;
    port 7000;
    options {
        tls;
        websocket { type text; }
    };
    tls-options {
        certificate "tls/irc.crt";
        key "tls/irc.key";
		options { no-client-certificate; }
    };
};
```

**Note:** The `no-client-certificate` is required to allow Chrome based browsers to connect. This is not required for Firefox though.

#### Load required modules

```
loadmodule "webserver";
loadmodule "websocket";
loadmodule "websocket_common";
```

### Help Build the Network List

We're creating a dropdown list of WebSocket-enabled IRC networks for easy connection. If your network supports WebSockets, [open an issue on GitHub](https://github.com/supernets/superchat/issues) with the following details:
- Network name
- WebSocket server address & port
- SSL/TLS support status
- Suggested default channels *(optional)*

Your contribution helps make IRC more accessible to browser-based users!

### GrapheneOS Note
If using GrapheneOS/Vanadium browser, you must enable JIT permissions for WebSocket connections to work properly.

---

###### Mirrors: [SuperNETs](https://git.supernets.org/supernets/superchat) • [GitHub](https://github.com/supernets/superchat) • [GitLab](https://gitlab.com/supernets/superchat) • [Codeberg](https://codeberg.org/supernets/superchat)
