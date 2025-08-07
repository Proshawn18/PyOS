// worker.js - Corrected Version

import { connect } from 'cloudflare:sockets';

export class PyosSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clientWs = null;
    this.remoteTcpSocket = null;
    this.tcpWriter = null;
    this._currentReader = null;
  }

  // A new, robust cleanup function to reset the worker's state.
  async cleanup() {
    // Cancel any active reader to stop the pump.
    if (this._currentReader) {
      try { await this._currentReader.cancel(); } catch (e) { /* Ignore errors */ }
      this._currentReader = null;
    }

    // Close the TCP writer.
    if (this.tcpWriter) {
      try { await this.tcpWriter.close(); } catch (e) { /* Ignore errors */ }
      this.tcpWriter = null;
    }

    // Close the TCP socket itself.
    if (this.remoteTcpSocket) {
      try { this.remoteTcpSocket.close(); } catch (e) { /* Ignore errors */ }
      // CRUCIAL: Reset the state variable to null for the next run.
      this.remoteTcpSocket = null;
    }
  }

  sendToClient(message) {
    if (this.clientWs && this.clientWs.readyState === WebSocket.OPEN) {
      this.clientWs.send(JSON.stringify(message));
    }
  }

  // In worker.js, replace the existing pumpTcpToWs function

async pumpTcpToWs() {
  // Ensure only one pump runs at a time.
  if (this._currentReader) {
    try { await this._currentReader.cancel(); } catch {}
  }
  const reader = this.remoteTcpSocket.readable.getReader();
  this._currentReader = reader;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        this.sendToClient({ type: 'tcp_closed' });
        break;
      }
      this.sendToClient({ type: 'tcp_data', data: btoa(String.fromCharCode(...value)) });
    }
  } catch (e) {
    // FIX: A "Stream was cancelled" error is expected when we upgrade to TLS
    // and replace the old reader. We will ignore this specific error.
    if (e.message === "Stream was cancelled.") {
      console.log("Read pump cancelled intentionally for TLS upgrade. This is normal.");
    } else {
      // For all other, unexpected errors, report them.
      console.error("TCP Read Pump Error:", e.toString());
      this.sendToClient({ type: 'tcp_error', error: `TCP Read Error: ${e.toString()}` });
    }
  } finally {
    // We only want to clean up if the remote TCP socket truly closes,
    // not when we're just switching pumps for a TLS upgrade.
    // The main cleanup is handled by the 'close' and 'error' event listeners on the WebSocket now.
  }
}

  async handleWebSocketMessage(msg) {
    try {
      switch (msg.type) {
        // In worker.js, inside handleWebSocketMessage()

case 'tcp_connect':
  if (this.remoteTcpSocket) {
    return this.sendToClient({ type: 'tcp_error', error: 'Already connected.' });
  }

  // FIX: Set the correct secureTransport option based on the port.
  let connectOptions = {};
  if (msg.port === 465) {
    // For port 465, we need implicit TLS from the start.
    connectOptions.secureTransport = "on";
  } else if (msg.port === 587) {
    // For port 587, we must declare our intent to use STARTTLS later.
    connectOptions.secureTransport = "starttls";
  }

  // Now, connect with the correct options.
  this.remoteTcpSocket = connect({ hostname: msg.host, port: msg.port }, connectOptions);
  
  this.tcpWriter = this.remoteTcpSocket.writable.getWriter();
  this.pumpTcpToWs();
  this.sendToClient({ type: 'tcp_connect_success' });
  break;

        case 'tcp_write':
          if (!this.tcpWriter) {
            return this.sendToClient({ type: 'tcp_error', error: 'Not connected.' });
          }
          const bin = atob(msg.data);
          const data = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
          await this.tcpWriter.write(data);
          break;

        // In worker.js, inside handleWebSocketMessage()

case 'tcp_starttls':
  if (!this.remoteTcpSocket) {
    return this.sendToClient({ type: 'tcp_error', error: 'Not connected for STARTTLS' });
  }

  // FIX: Explicitly release control of BOTH the reader and the writer
  // from the old, plain-text socket before upgrading.
  if (this._currentReader) {
    await this._currentReader.cancel();
  }
  if (this.tcpWriter) {
    this.tcpWriter.releaseLock();
  }

  // Now that all resources are released, the runtime can safely upgrade the connection.
  this.remoteTcpSocket = await this.remoteTcpSocket.startTls({});

  // Get a new writer and start a new pump for the new secure stream.
  this.tcpWriter = this.remoteTcpSocket.writable.getWriter();
  this.pumpTcpToWs();
  
  this.sendToClient({ type: 'tcp_starttls_success' });
  break;

        case 'tcp_close':
          await this.cleanup();
          break;

        default:
          this.sendToClient({ type: 'tcp_error', error: `Unknown command: ${msg.type}` });
          break;
      }
    } catch (e) {
      console.error("Handler Error:", e.toString());
      this.sendToClient({ type: 'tcp_error', error: e.toString() });
      await this.cleanup();
    }
  }

  async fetch(request) {
    // ... (This part of your worker code is fine and does not need changes)
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const [client, server] = new WebSocketPair();
    this.clientWs = server;
    this.clientWs.accept();
    const onCloseOrError = async () => {
      // When the browser closes the connection, clean up the TCP socket.
      await this.cleanup();
    };
    this.clientWs.addEventListener('message', ev => this.handleWebSocketMessage(JSON.parse(ev.data)));
    this.clientWs.addEventListener('close', onCloseOrError);
    this.clientWs.addEventListener('error', onCloseOrError);
    return new Response(null, { status: 101, webSocket: client });
  }
}

// Default export remains the same
export default {
    async fetch(request, env) {
        // ... (This part is also fine and needs no changes)
        const url = new URL(request.url);
        // Use a more robust way to get a session ID if needed, but this is okay.
        const sessionId = url.pathname.split('/proxy-session')[0] || url.pathname;
        const id = env.SESSIONS.idFromName(sessionId.slice(1));
        const stub = env.SESSIONS.get(id);
        return await stub.fetch(request);
    }
};