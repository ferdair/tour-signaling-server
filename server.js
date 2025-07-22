// server.js - Signaling Server with Bun
const tours = new Map(); // tourId -> { guide: { ws, userId }, participants: Map<userId, ws> }
const connections = new Map(); // ws -> { userId, tourId }

const server = Bun.serve({
  port: process.env.PORT || 3000,
  websocket: {
    message(ws, message) {
      try {
        const data = JSON.parse(message);
        const connectionInfo = connections.get(ws);
        if (connectionInfo) {
          handleMessage(ws, data, connectionInfo);
        }
      } catch (error) {
        console.error('Error parsing message:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    },

    open(ws) {
      console.log('Client connected');
    },

    close(ws) {
      handleDisconnection(ws);
    }
  },

  fetch(req, server) {
    const url = new URL(req.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 500, headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      const body = JSON.stringify({ 
        status: 'ok', 
        tours: tours.size,
        connections: connections.size 
      });
      return new Response(body, { headers: { "Content-Type": "application/json", ...corsHeaders }});
    }

    return new Response("WebRTC Signaling Server", { status: 200, headers: corsHeaders });
  },
});

function handleMessage(ws, data, connectionInfo) {
  const { type, tourId, userId } = data;
  const { userId: fromId } = connectionInfo;

  switch (type) {
    case 'join-tour':
      joinTour(ws, tourId, userId, data.role);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
      relay(fromId, tourId, data);
      break;
    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

function joinTour(ws, tourId, userId, role) {
  leaveTour(ws); // Ensure user is not in other tours first

  if (!tours.has(tourId)) {
    tours.set(tourId, { guide: null, participants: new Map() });
  }
  const tour = tours.get(tourId);
  connections.set(ws, { userId, tourId });

  if (role === 'guide') {
    if (tour.guide) {
      ws.send(JSON.stringify({ type: 'error', message: 'Tour already has a guide' }));
      connections.delete(ws);
      return;
    }
    tour.guide = { ws, userId };
    console.log(`Guide ${userId} created/joined tour ${tourId}`);
  } else if (role === 'participant') {
    tour.participants.set(userId, ws);
    console.log(`Participant ${userId} joined tour ${tourId} (${tour.participants.size} total)`);
    
    if (tour.guide) {
      tour.guide.ws.send(JSON.stringify({
        type: 'participant-joined',
        participantId: userId,
      }));
    }
  }
}

function leaveTour(ws) {
  const connection = connections.get(ws);
  if (!connection) return;

  const { userId, tourId } = connection;
  const tour = tours.get(tourId);
  
  if (!tour) return;

  if (tour.guide && tour.guide.userId === userId) {
    console.log(`Guide ${userId} left tour ${tourId}`);
    for (const participantWs of tour.participants.values()) {
      participantWs.send(JSON.stringify({ type: 'guide-left' }));
    }
    tours.delete(tourId);
    console.log(`Tour ${tourId} deleted.`);
  } else if (tour.participants.has(userId)) {
    tour.participants.delete(userId);
    console.log(`Participant ${userId} left tour ${tourId} (${tour.participants.size} remaining)`);
    if (tour.guide) {
      tour.guide.ws.send(JSON.stringify({
        type: 'participant-left',
        participantId: userId,
      }));
    }
  }

  connections.delete(ws);
}

function relay(fromId, tourId, data) {
    const tour = tours.get(tourId);
    if (!tour) return;

    const targetId = data.targetId;
    let targetWs;

    if (tour.guide && tour.guide.userId === targetId) {
        targetWs = tour.guide.ws;
    } 
    else {
        targetWs = tour.participants.get(targetId);
    }
    
    if (targetWs) {
        targetWs.send(JSON.stringify({ ...data, fromId }));
    } else {
        console.log(`Could not find target ${targetId} in tour ${tourId}`);
    }
}

function handleDisconnection(ws) {
  console.log('Client disconnected');
  leaveTour(ws);
}

console.log(`🚀 Signaling server running on port ${server.port}`);
console.log(`WebSocket endpoint: ws://localhost:${server.port}/ws`);
console.log(`Health check: http://localhost:${server.port}/health`);
