const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Constants
const BITHUMB_URL = 'https://api.bithumb.com/public/ticker/ETH_KRW';
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = 60000; // 60 seconds
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Global state
let latestPrice = null;
const sseClients = new Map();
let clientIdCounter = 0;

/**
 * Fetch latest ETH price from Bithumb API
 */
function fetchPrice() {
  https.get(BITHUMB_URL, { timeout: 10000 }, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        
        if (response.status === '0000' && response.data) {
          const priceData = response.data;
          latestPrice = {
            symbol: 'ETH_KRW',
            current_price: Number(priceData.closing_price),
            opening_price: Number(priceData.opening_price),
            min_price: Number(priceData.min_price),
            max_price: Number(priceData.max_price),
            fluctate_rate_24h: priceData.fluctate_rate_24H,
            updated_at: new Date().toISOString()
          };

          console.log(`[${latestPrice.updated_at}] Price updated: ₩${latestPrice.current_price}`);
          
          // Broadcast to all SSE clients
          broadcast('price', {
            current_price: latestPrice.current_price,
            fluctate_rate_24h: latestPrice.fluctate_rate_24h,
            updated_at: latestPrice.updated_at
          });
        } else {
          console.error('Bithumb API error:', response.status);
          broadcast('error', { message: 'Bithumb API error' });
        }
      } catch (err) {
        console.error('Failed to parse Bithumb response:', err.message);
        broadcast('error', { message: 'Failed to parse response' });
      }
    });
  }).on('error', (err) => {
    console.error('Fetch price error:', err.message);
    broadcast('error', { message: 'Fetch failed' });
  });
}

/**
 * Broadcast message to all connected SSE clients
 */
function broadcast(eventName, data) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  
  sseClients.forEach((res) => {
    try {
      res.write(message);
    } catch (err) {
      console.error('Failed to broadcast to client:', err.message);
    }
  });
}

/**
 * Send heartbeat to keep SSE connections alive
 */
function sendHeartbeat() {
  const ping = ': ping\n\n';
  
  sseClients.forEach((res) => {
    try {
      res.write(ping);
    } catch (err) {
      console.error('Failed to send heartbeat:', err.message);
    }
  });
}

/**
 * HTTP Server
 */
const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // Route: GET /
  if (pathname === '/' && req.method === 'GET') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading index.html');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
  }
  // Route: GET /price
  else if (pathname === '/price' && req.method === 'GET') {
    if (latestPrice) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(latestPrice));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'price not yet available', code: 503 }));
    }
  }
  // Route: GET /events (SSE)
  else if (pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Register client
    const clientId = clientIdCounter++;
    sseClients.set(clientId, res);
    console.log(`SSE client connected: ${clientId} (total: ${sseClients.size})`);

    // Send initial message
    res.write(': connected\n\n');

    // Send latest price immediately if available
    if (latestPrice) {
      const initialMessage = `event: price\ndata: ${JSON.stringify({
        current_price: latestPrice.current_price,
        fluctate_rate_24h: latestPrice.fluctate_rate_24h,
        updated_at: latestPrice.updated_at
      })}\n\n`;
      res.write(initialMessage);
    }

    // Handle client disconnect
    req.on('close', () => {
      sseClients.delete(clientId);
      console.log(`SSE client disconnected: ${clientId} (total: ${sseClients.size})`);
    });

    res.on('error', (err) => {
      console.error(`SSE client error: ${clientId}`, err.message);
      sseClients.delete(clientId);
    });
  }
  // Route: 404
  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`\n🚀 Bithumb ETH Tracker listening on http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop\n');

  // Fetch price immediately
  console.log('📡 Fetching initial price...');
  fetchPrice();

  // Poll Bithumb API every 60 seconds
  setInterval(fetchPrice, POLL_INTERVAL);

  // Send heartbeat every 30 seconds
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down...');
  sseClients.forEach((res) => res.end());
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});
