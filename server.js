const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Constants
const BITHUMB_URL = 'https://api.bithumb.com/public/ticker/ETH_KRW';
const BITHUMB_ALL_URL = 'https://api.bithumb.com/public/ticker/ALL_KRW';
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL = 60000; // 60 seconds
const TOP10_POLL_INTERVAL = 60000; // 60 seconds
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Global state
let latestPrice = null;
const sseClients = new Map();
let clientIdCounter = 0;

// TOP10 state
let latestTop10 = null;
const top10SseClients = new Map();
let top10ClientIdCounter = 0;

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
 * Fetch latest TOP10 coins from Bithumb API
 */
function fetchTop10() {
  https.get(BITHUMB_ALL_URL, { timeout: 10000 }, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        
        if (response.status === '0000' && response.data) {
          // Filter out 'date' key and get coin entries
          const entries = Object.entries(response.data).filter(([k]) => k !== 'date');
          
          // Sort by acc_trade_value_24H in descending order
          entries.sort((a, b) => {
            const aValue = Number(a[1].acc_trade_value_24H) || 0;
            const bValue = Number(b[1].acc_trade_value_24H) || 0;
            return bValue - aValue;
          });
          
          // Extract top 10
          const top10 = entries.slice(0, 10).map(([symbol, priceData], index) => ({
            rank: index + 1,
            symbol: symbol,
            current_price: Number(priceData.closing_price),
            fluctate_rate_24h: priceData.fluctate_rate_24H,
            acc_trade_value_24h: Number(priceData.acc_trade_value_24H),
            acc_trade_volume_24h: Number(priceData.acc_trade_volume_24H)
          }));
          
          latestTop10 = {
            updated_at: new Date().toISOString(),
            coins: top10
          };
          
          console.log(`[${latestTop10.updated_at}] TOP10 updated: ${top10.map(c => `${c.rank}. ${c.symbol}`).join(', ')}`);
          
          // Broadcast to all TOP10 SSE clients
          broadcastTop10('top10', latestTop10);
        } else {
          console.error('Bithumb ALL_KRW API error:', response.status);
          broadcastTop10('error', { message: 'Bithumb API error' });
        }
      } catch (err) {
        console.error('Failed to parse Bithumb ALL_KRW response:', err.message);
        broadcastTop10('error', { message: 'Failed to parse response' });
      }
    });
  }).on('error', (err) => {
    console.error('Fetch TOP10 error:', err.message);
    broadcastTop10('error', { message: 'Fetch failed' });
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
 * Broadcast message to all connected TOP10 SSE clients
 */
function broadcastTop10(eventName, data) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  
  top10SseClients.forEach((res) => {
    try {
      res.write(message);
    } catch (err) {
      console.error('Failed to broadcast TOP10 to client:', err.message);
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
 * Send heartbeat to TOP10 SSE clients
 */
function sendTop10Heartbeat() {
  const ping = ': ping\n\n';
  
  top10SseClients.forEach((res) => {
    try {
      res.write(ping);
    } catch (err) {
      console.error('Failed to send TOP10 heartbeat:', err.message);
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
  // Route: GET /top10
  else if (pathname === '/top10' && req.method === 'GET') {
    const filePath = path.join(__dirname, 'public', 'top10.html');
    
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading top10.html');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
  }
  // Route: GET /top10/data
  else if (pathname === '/top10/data' && req.method === 'GET') {
    if (latestTop10) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(latestTop10));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'top10 data not yet available', code: 503 }));
    }
  }
  // Route: GET /top10/events (SSE)
  else if (pathname === '/top10/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Register client
    const clientId = top10ClientIdCounter++;
    top10SseClients.set(clientId, res);
    console.log(`TOP10 SSE client connected: ${clientId} (total: ${top10SseClients.size})`);

    // Send initial message
    res.write(': connected\n\n');

    // Send latest TOP10 immediately if available
    if (latestTop10) {
      const initialMessage = `event: top10\ndata: ${JSON.stringify(latestTop10)}\n\n`;
      res.write(initialMessage);
    }

    // Handle client disconnect
    req.on('close', () => {
      top10SseClients.delete(clientId);
      console.log(`TOP10 SSE client disconnected: ${clientId} (total: ${top10SseClients.size})`);
    });

    res.on('error', (err) => {
      console.error(`TOP10 SSE client error: ${clientId}`, err.message);
      top10SseClients.delete(clientId);
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

  // Fetch TOP10 immediately
  console.log('📡 Fetching initial TOP10...');
  fetchTop10();

  // Poll TOP10 every 60 seconds
  setInterval(fetchTop10, TOP10_POLL_INTERVAL);

  // Send heartbeat every 30 seconds
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  // Send TOP10 heartbeat every 30 seconds
  setInterval(sendTop10Heartbeat, HEARTBEAT_INTERVAL);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down...');
  sseClients.forEach((res) => res.end());
  top10SseClients.forEach((res) => res.end());
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});
